import { ClientSession, Collection, Db, ObjectId } from 'mongodb';
import { DailySummaryDocument, LeadEventDocument } from '../database/models';
import DatabaseConnection from '../database/connection';
import { Logger } from '../utils/logger';
import {
  AuditEvent,
  AuditEventDocument,
  Campaign,
  CampaignDocument,
  ForecastRevision,
  ForecastRevisionDocument,
  SpendRecord,
  SpendRecordDocument,
  SalesProjectionDocument,
  SalesSyncCursorDocument,
  MalformedSalesRecordDocument,
  SalesAuditEventDocument,
} from './models';
import {
  LeadForSaleAttribution,
  SalesProjection,
  SalesProjectionRepository,
  SalesSyncCursor,
} from './sync-service';
import { SummaryDataRepository } from './summary-service';

export interface LeadControlRepository {
  createCampaign(campaign: Omit<Campaign, 'id'>): Promise<Campaign>;
  updateCampaign(campaign: Campaign): Promise<void>;
  getCampaign(id: string): Promise<Campaign | null>;
  listCampaignsForPage(pageId: string): Promise<Campaign[]>;
  deleteCampaign(id: string): Promise<void>;
  createRevision(revision: Omit<ForecastRevision, 'id'>): Promise<ForecastRevision>;
  updateRevision(revision: ForecastRevision): Promise<void>;
  getRevision(id: string): Promise<ForecastRevision | null>;
  listRevisions(campaignId: string, month?: string): Promise<ForecastRevision[]>;
  deleteRevision(id: string): Promise<void>;
  createSpend(spend: Omit<SpendRecord, 'id'>): Promise<SpendRecord>;
  updateSpend(spend: SpendRecord): Promise<void>;
  getSpend(id: string): Promise<SpendRecord | null>;
  listSpend(campaignId: string, month?: string): Promise<SpendRecord[]>;
  appendAuditEvent(event: Omit<AuditEvent, 'id'>): Promise<void>;
  runAtomic<T>(keys: readonly string[], operation: (repository: LeadControlRepository) => Promise<T>): Promise<T>;
}

const CAMPAIGNS = 'lead_control_campaigns';
const REVISIONS = 'lead_control_forecast_revisions';
const SPEND = 'lead_control_spend_records';
const EVENTS = 'lead_control_audit_events';
const GUARDS = 'lead_control_mutation_guards';
const SALES_PROJECTIONS = 'lead_control_sales_projections';
const SALES_CURSOR = 'lead_control_sales_sync_cursor';
const MALFORMED_SALES = 'lead_control_malformed_sales';
const SALES_AUDIT = 'lead_control_sales_audit_events';
const LEAD_EVENTS = 'leads_events';
const DAILY_SUMMARIES = 'daily_summaries';

export const DAILY_SUMMARY_INDEXES = [
  { key: { campaign_id: 1, date: 1 }, name: 'campaign_month_summary_lookup' },
];

export const SALES_PROJECTION_INDEXES = [
  { key: { sale_id: 1 }, name: 'sale_id_unique', unique: true },
  { key: { normalized_phone: 1, booking_date: 1 }, name: 'phone_booking_lookup' },
  { key: { campaign_id: 1, booking_date: 1 }, name: 'campaign_booking_lookup' },
  { key: { attribution_kind: 1, updated_at: -1 }, name: 'unmatched_reconciliation_lookup' },
  { key: { status: 1, booking_date: 1 }, name: 'status_booking_lookup' },
  { key: { status: 1, cancelled_date: 1 }, name: 'status_cancellation_event_lookup' },
  { key: { updated_at: 1, sale_id: 1 }, name: 'source_updated_cursor_lookup' },
];

interface MutationGuardDocument {
  _id: string;
  version: number;
}

const indexInitialization = new WeakMap<Db, Promise<void>>();

export class MongoLeadControlRepository implements LeadControlRepository, SalesProjectionRepository, SummaryDataRepository {
  private readonly campaigns: Collection<CampaignDocument>;
  private readonly revisions: Collection<ForecastRevisionDocument>;
  private readonly spend: Collection<SpendRecordDocument>;
  private readonly events: Collection<AuditEventDocument>;
  private readonly guards: Collection<MutationGuardDocument>;
  private readonly saleProjections: Collection<SalesProjectionDocument>;
  private readonly salesCursor: Collection<SalesSyncCursorDocument>;
  private readonly malformedSales: Collection<MalformedSalesRecordDocument>;
  private readonly salesAudit: Collection<SalesAuditEventDocument>;
  private readonly leadEvents: Collection<LeadEventDocument>;
  private readonly dailySummaries: Collection<DailySummaryDocument>;

  constructor(
    private readonly db: Db = DatabaseConnection.getInstance().getDb(),
    private readonly session?: ClientSession,
  ) {
    this.campaigns = db.collection<CampaignDocument>(CAMPAIGNS);
    this.revisions = db.collection<ForecastRevisionDocument>(REVISIONS);
    this.spend = db.collection<SpendRecordDocument>(SPEND);
    this.events = db.collection<AuditEventDocument>(EVENTS);
    this.guards = db.collection<MutationGuardDocument>(GUARDS);
    this.saleProjections = db.collection<SalesProjectionDocument>(SALES_PROJECTIONS);
    this.salesCursor = db.collection<SalesSyncCursorDocument>(SALES_CURSOR);
    this.malformedSales = db.collection<MalformedSalesRecordDocument>(MALFORMED_SALES);
    this.salesAudit = db.collection<SalesAuditEventDocument>(SALES_AUDIT);
    this.leadEvents = db.collection<LeadEventDocument>(LEAD_EVENTS);
    this.dailySummaries = db.collection<DailySummaryDocument>(DAILY_SUMMARIES);
    if (!session) {
      void this.ensureIndexes().catch((error: unknown) => Logger.error('Lead Control index creation failed', error as Error));
    }
  }

  async ensureIndexes(): Promise<void> {
    const existing = indexInitialization.get(this.db);
    if (existing) return existing;
    const initialization = this.createIndexes();
    indexInitialization.set(this.db, initialization);
    try {
      await initialization;
    } catch (error) {
      if (indexInitialization.get(this.db) === initialization) indexInitialization.delete(this.db);
      throw error;
    }
  }

  private async createIndexes(): Promise<void> {
    await Promise.all([
      this.campaigns.createIndexes([
        { key: { page_id: 1, status: 1, starts_on: 1, ends_on: 1 }, name: 'active_page_date_lookup' },
        { key: { page_id: 1, starts_on: 1, ends_on: 1, status: 1 }, name: 'same_page_range_guard', unique: true },
      ]),
      this.revisions.createIndexes([
        { key: { campaign_id: 1, month: 1, revision_number: 1 }, name: 'campaign_month_revision', unique: true },
        { key: { campaign_id: 1, month: 1, status: 1 }, name: 'campaign_month_status' },
      ]),
      this.spend.createIndexes([
        {
          key: { campaign_id: 1, month: 1, business_date: 1 },
          name: 'active_spend_record_guard',
          unique: true,
          partialFilterExpression: { status: 'active' },
        },
        { key: { campaign_id: 1, month: 1, status: 1, mode: 1 }, name: 'campaign_month_spend_lookup' },
      ]),
      this.events.createIndexes([
        { key: { entity_type: 1, entity_id: 1, occurred_at: -1 }, name: 'entity_audit_history' },
        { key: { actor: 1, occurred_at: -1 }, name: 'actor_audit_history' },
      ]),
      this.guards.createIndex({ version: 1 }, { name: 'mutation_guard_version' }),
      this.saleProjections.createIndexes(SALES_PROJECTION_INDEXES),
      this.malformedSales.createIndex({ recorded_at: -1 }, { name: 'malformed_sales_recorded_at' }),
      this.salesAudit.createIndex({ sale_id: 1, occurred_at: -1 }, { name: 'sale_audit_history' }),
      this.leadEvents.createIndex(
        { normalized_phone: 1, date: -1, created_at: -1 },
        { name: 'sale_attribution_normalized_phone_date', sparse: true },
      ),
      this.dailySummaries.createIndexes(DAILY_SUMMARY_INDEXES),
    ]);
  }

  async createCampaign(campaign: Omit<Campaign, 'id'>): Promise<Campaign> {
    const result = await this.campaigns.insertOne({ _id: new ObjectId(), ...campaignDocument(campaign) }, this.options());
    return { ...campaign, id: result.insertedId.toHexString() };
  }

  async updateCampaign(campaign: Campaign): Promise<void> {
    await this.campaigns.replaceOne({ _id: objectId(campaign.id) }, campaignDocument(campaign), this.options());
  }

  async getCampaign(id: string): Promise<Campaign | null> {
    const identifier = objectIdOrNull(id);
    if (!identifier) return null;
    const document = await this.campaigns.findOne({ _id: identifier }, this.options());
    return document ? campaignFromDocument(document) : null;
  }

  async listCampaignsForPage(pageId: string): Promise<Campaign[]> {
    return (await this.campaigns.find({
      $or: [
        { page_id: pageId },
        { page_id: pageIdCompatibilityPattern(pageId) },
      ],
    }, this.options()).toArray()).map(campaignFromDocument);
  }

  async deleteCampaign(id: string): Promise<void> {
    await this.campaigns.deleteOne({ _id: objectId(id) }, this.options());
  }

  async createRevision(revision: Omit<ForecastRevision, 'id'>): Promise<ForecastRevision> {
    const result = await this.revisions.insertOne({ _id: new ObjectId(), ...revisionDocument(revision) }, this.options());
    return { ...revision, id: result.insertedId.toHexString() };
  }

  async updateRevision(revision: ForecastRevision): Promise<void> {
    await this.revisions.replaceOne({ _id: objectId(revision.id) }, revisionDocument(revision), this.options());
  }

  async getRevision(id: string): Promise<ForecastRevision | null> {
    const identifier = objectIdOrNull(id);
    if (!identifier) return null;
    const document = await this.revisions.findOne({ _id: identifier }, this.options());
    return document ? revisionFromDocument(document) : null;
  }

  async listRevisions(campaignId: string, month?: string): Promise<ForecastRevision[]> {
    const identifier = objectIdOrNull(campaignId);
    if (!identifier) return [];
    return (await this.revisions.find({ campaign_id: identifier, ...(month === undefined ? {} : { month }) }, this.options()).toArray()).map(revisionFromDocument);
  }

  async deleteRevision(id: string): Promise<void> {
    await this.revisions.deleteOne({ _id: objectId(id) }, this.options());
  }

  async createSpend(spend: Omit<SpendRecord, 'id'>): Promise<SpendRecord> {
    const result = await this.spend.insertOne({ _id: new ObjectId(), ...spendDocument(spend) }, this.options());
    return { ...spend, id: result.insertedId.toHexString() };
  }

  async updateSpend(spend: SpendRecord): Promise<void> {
    await this.spend.replaceOne({ _id: objectId(spend.id) }, spendDocument(spend), this.options());
  }

  async getSpend(id: string): Promise<SpendRecord | null> {
    const identifier = objectIdOrNull(id);
    if (!identifier) return null;
    const document = await this.spend.findOne({ _id: identifier }, this.options());
    return document ? spendFromDocument(document) : null;
  }

  async listSpend(campaignId: string, month?: string): Promise<SpendRecord[]> {
    const identifier = objectIdOrNull(campaignId);
    if (!identifier) return [];
    return (await this.spend.find({ campaign_id: identifier, ...(month === undefined ? {} : { month }) }, this.options()).toArray()).map(spendFromDocument);
  }

  async appendAuditEvent(event: Omit<AuditEvent, 'id'>): Promise<void> {
    await this.events.insertOne({
      _id: new ObjectId(),
      action: event.action,
      actor: event.actor,
      entity_type: event.entityType,
      entity_id: objectId(event.entityId),
      occurred_at: event.occurredAt,
      details: event.details,
    }, this.options());
  }

  async listDailySummaries(campaignId: string, month: string): Promise<DailySummaryDocument[]> {
    const nextMonth = followingMonth(month);
    return this.dailySummaries.find({
      campaign_id: campaignId,
      date: { $gte: `${month}-01`, $lt: `${nextMonth}-01` },
    }, this.options()).sort({ date: 1 }).toArray();
  }

  async listSalesProjections(campaignId: string): Promise<SalesProjection[]> {
    return (await this.saleProjections.find({ campaign_id: campaignId }, this.options()).sort({ booking_date: 1, sale_id: 1 }).toArray()).map(saleProjectionFromDocument);
  }

  async listUnmatchedSales(): Promise<SalesProjection[]> {
    return (await this.saleProjections.find({ attribution_kind: 'unmatched' }, this.options()).sort({ updated_at: -1, sale_id: 1 }).toArray()).map(saleProjectionFromDocument);
  }

  async countMalformedSales(): Promise<number> {
    return this.malformedSales.countDocuments({}, this.options());
  }

  async getSalesSyncCursor(): Promise<SalesSyncCursor | null> {
    const cursor = await this.salesCursor.findOne({ _id: 'sales' }, this.options());
    return cursor ? { updatedAt: cursor.updated_at, saleId: cursor.sale_id } : null;
  }

  async saveSalesSyncCursor(cursor: SalesSyncCursor): Promise<void> {
    await this.salesCursor.updateOne(
      { _id: 'sales' },
      { $set: { updated_at: cursor.updatedAt, sale_id: cursor.saleId } },
      { upsert: true, ...this.options() },
    );
  }

  async getSaleProjection(saleId: string): Promise<SalesProjection | null> {
    const sale = await this.saleProjections.findOne({ sale_id: saleId }, this.options());
    return sale ? saleProjectionFromDocument(sale) : null;
  }

  async saveSaleProjection(sale: SalesProjection): Promise<void> {
    await this.saleProjections.updateOne(
      { sale_id: sale.saleId },
      { $set: saleProjectionDocument(sale) },
      { upsert: true, ...this.options() },
    );
  }

  async recordMalformedSale(saleId: string | null, reason: string): Promise<void> {
    const key = `${saleId ?? '<missing>'}:${reason}`;
    await this.malformedSales.updateOne(
      { _id: key },
      { $setOnInsert: { sale_id: saleId, reason, recorded_at: new Date() } },
      { upsert: true, ...this.options() },
    );
  }

  async findMostRecentLeadBefore(phone: string, bookingDate: Date): Promise<LeadForSaleAttribution | null> {
    const lead = await this.leadEvents.find(
      saleAttributionLeadFilter(phone, bookingDate),
      this.options(),
    ).sort({ date: -1, created_at: -1 }).limit(1).next();
    if (!lead || lead._id === undefined || typeof lead.campaign_id !== 'string') return null;
    return {
      id: String(lead._id),
      normalizedPhone: phone,
      occurredAt: lead.created_at,
      campaignId: lead.campaign_id,
    };
  }

  async appendSalesAudit(action: string, actor: string, saleId: string): Promise<void> {
    await this.salesAudit.insertOne({
      _id: new ObjectId(),
      sale_id: saleId,
      action,
      actor,
      occurred_at: new Date(),
    }, this.options());
  }

  async runSalesAtomic<T>(keys: readonly string[], operation: (repository: SalesProjectionRepository) => Promise<T>): Promise<T> {
    return this.runAtomic(keys, async (repository) => operation(repository as unknown as SalesProjectionRepository));
  }

  async runAtomic<T>(keys: readonly string[], operation: (repository: LeadControlRepository) => Promise<T>): Promise<T> {
    const lockKeys = [...new Set(keys)].sort();
    const session = this.db.client.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        for (const key of lockKeys) {
          await this.guards.updateOne(
            { _id: key },
            { $inc: { version: 1 } },
            { upsert: true, session },
          );
        }
        result = await operation(new MongoLeadControlRepository(this.db, session));
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  private options(): { session?: ClientSession } {
    return this.session ? { session: this.session } : {};
  }

}

/** Exact indexed lookup for the newest attributable local lead before a booking date. */
export function saleAttributionLeadFilter(phone: string, bookingDate: Date): Record<string, unknown> {
  return {
    normalized_phone: phone,
    campaign_id: { $type: 'string' },
    deleted: { $ne: true },
    date: { $lt: bookingDate.toISOString().slice(0, 10) },
  };
}

/**
 * Compatibility lookup for campaigns saved before page IDs were canonicalized.
 * Exact canonical matches still use the indexed branch; this regex is only a
 * bounded fallback for legacy casing, whitespace, and report-style prefixes.
 */
export function pageIdCompatibilityPattern(canonicalPageId: string): RegExp {
  const tokens = canonicalPageId.trim().split(/\s+/).filter(Boolean).map(escapeRegex);
  const value = tokens.join('\\s+');
  return new RegExp(`^\\s*(?:🚩\\s*)?(?:(?:page|pae|ផេក)\\s*[:：-]?\\s*)?${value}\\s*$`, 'iu');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function followingMonth(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RangeError('month must be YYYY-MM');
  const [year, monthNumber] = month.split('-').map(Number);
  const value = new Date(Date.UTC(year, monthNumber, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
}

function objectId(id: string): ObjectId {
  if (!ObjectId.isValid(id)) throw new RangeError('id must be a valid Mongo ObjectId');
  return new ObjectId(id);
}

function objectIdOrNull(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

function campaignDocument(campaign: Omit<Campaign, 'id'> | Campaign): Omit<CampaignDocument, '_id'> {
  return {
    name: campaign.name,
    page_id: campaign.pageId,
    ...(campaign.propertyProject === undefined ? {} : { property_project: campaign.propertyProject }),
    ...(campaign.objective === undefined ? {} : { objective: campaign.objective }),
    ...(campaign.audience === undefined ? {} : { audience: campaign.audience }),
    ...(campaign.spendMode === undefined ? {} : { spend_mode: campaign.spendMode }),
    starts_on: campaign.startsOn,
    ends_on: campaign.endsOn,
    status: campaign.status,
    created_at: campaign.createdAt,
    created_by: campaign.createdBy,
    archived_at: campaign.archivedAt,
    archived_by: campaign.archivedBy,
  };
}

function campaignFromDocument(document: CampaignDocument): Campaign {
  return {
    id: document._id.toHexString(),
    name: document.name,
    pageId: document.page_id,
    ...(document.property_project === undefined ? {} : { propertyProject: document.property_project }),
    ...(document.objective === undefined ? {} : { objective: document.objective }),
    ...(document.audience === undefined ? {} : { audience: document.audience }),
    ...(document.spend_mode === undefined ? {} : { spendMode: document.spend_mode }),
    startsOn: document.starts_on,
    endsOn: document.ends_on,
    status: document.status,
    createdAt: document.created_at,
    createdBy: document.created_by,
    archivedAt: document.archived_at,
    archivedBy: document.archived_by,
  };
}

function revisionDocument(revision: Omit<ForecastRevision, 'id'> | ForecastRevision): Omit<ForecastRevisionDocument, '_id'> {
  return {
    campaign_id: objectId(revision.campaignId),
    month: revision.month,
    monthly_budget_cents: revision.monthlyBudgetCents,
    cost_per_message_cents: revision.costPerMessageCents,
    message_to_phone_rate: revision.messageToPhoneRate,
    phone_to_visit_rate: revision.phoneToVisitRate,
    visit_to_booking_rate: revision.visitToBookingRate,
    cancellation_rate: revision.cancellationRate,
    revision_number: revision.revisionNumber,
    kind: revision.kind,
    status: revision.status,
    created_at: revision.createdAt,
    created_by: revision.createdBy,
    approved_at: revision.approvedAt,
    approved_by: revision.approvedBy,
  };
}

function revisionFromDocument(document: ForecastRevisionDocument): ForecastRevision {
  return {
    id: document._id.toHexString(),
    campaignId: document.campaign_id.toHexString(),
    month: document.month,
    monthlyBudgetCents: document.monthly_budget_cents,
    costPerMessageCents: document.cost_per_message_cents,
    messageToPhoneRate: document.message_to_phone_rate,
    phoneToVisitRate: document.phone_to_visit_rate,
    visitToBookingRate: document.visit_to_booking_rate,
    cancellationRate: document.cancellation_rate,
    revisionNumber: document.revision_number,
    kind: document.kind,
    status: document.status,
    createdAt: document.created_at,
    createdBy: document.created_by,
    approvedAt: document.approved_at,
    approvedBy: document.approved_by,
  };
}

function spendDocument(spend: Omit<SpendRecord, 'id'> | SpendRecord): Omit<SpendRecordDocument, '_id'> {
  return {
    campaign_id: objectId(spend.campaignId),
    month: spend.month,
    business_date: spend.businessDate,
    amount_cents: spend.amountCents,
    mode: spend.mode,
    status: spend.status,
    created_at: spend.createdAt,
    created_by: spend.createdBy,
    archived_at: spend.archivedAt,
    archived_by: spend.archivedBy,
  };
}

function spendFromDocument(document: SpendRecordDocument): SpendRecord {
  return {
    id: document._id.toHexString(),
    campaignId: document.campaign_id.toHexString(),
    month: document.month,
    businessDate: document.business_date,
    amountCents: document.amount_cents,
    mode: document.mode,
    status: document.status,
    createdAt: document.created_at,
    createdBy: document.created_by,
    archivedAt: document.archived_at,
    archivedBy: document.archived_by,
  };
}

function saleProjectionDocument(sale: SalesProjection): Omit<SalesProjectionDocument, '_id'> {
  return {
    sale_id: sale.saleId,
    status: sale.status,
    normalized_phone: sale.normalizedPhone,
    booking_date: sale.bookingDate,
    completed_date: sale.completedDate,
    cancelled_date: sale.cancelledDate,
    updated_at: sale.updatedAt,
    campaign_id: sale.campaignId,
    attributed_lead_id: sale.attributedLeadId,
    attribution_kind: sale.attributionKind,
    attributed_at: sale.attributedAt,
  };
}

function saleProjectionFromDocument(document: SalesProjectionDocument): SalesProjection {
  return {
    saleId: document.sale_id,
    status: document.status,
    normalizedPhone: document.normalized_phone,
    bookingDate: document.booking_date,
    completedDate: document.completed_date,
    cancelledDate: document.cancelled_date,
    updatedAt: document.updated_at,
    campaignId: document.campaign_id,
    attributedLeadId: document.attributed_lead_id,
    attributionKind: document.attribution_kind,
    attributedAt: document.attributed_at,
  };
}
