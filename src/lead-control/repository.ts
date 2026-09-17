import { ClientSession, Collection, Db, ObjectId } from 'mongodb';
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
} from './models';

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
const LOCKS = 'lead_control_mutation_locks';

interface MutationLockDocument {
  _id: string;
  owner: string;
  expires_at: Date;
}

const indexInitialization = new WeakMap<Db, Promise<void>>();

export class MongoLeadControlRepository implements LeadControlRepository {
  private readonly campaigns: Collection<CampaignDocument>;
  private readonly revisions: Collection<ForecastRevisionDocument>;
  private readonly spend: Collection<SpendRecordDocument>;
  private readonly events: Collection<AuditEventDocument>;
  private readonly locks: Collection<MutationLockDocument>;

  constructor(
    private readonly db: Db = DatabaseConnection.getInstance().getDb(),
    private readonly session?: ClientSession,
  ) {
    this.campaigns = db.collection<CampaignDocument>(CAMPAIGNS);
    this.revisions = db.collection<ForecastRevisionDocument>(REVISIONS);
    this.spend = db.collection<SpendRecordDocument>(SPEND);
    this.events = db.collection<AuditEventDocument>(EVENTS);
    this.locks = db.collection<MutationLockDocument>(LOCKS);
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
      this.locks.createIndex({ expires_at: 1 }, { name: 'mutation_lock_expiry', expireAfterSeconds: 0 }),
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
    return (await this.campaigns.find({ page_id: pageId }, this.options()).toArray()).map(campaignFromDocument);
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

  async runAtomic<T>(keys: readonly string[], operation: (repository: LeadControlRepository) => Promise<T>): Promise<T> {
    const owner = new ObjectId().toHexString();
    const lockKeys = [...new Set(keys)].sort();
    await this.acquireLocks(lockKeys, owner);
    const session = this.db.client.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await operation(new MongoLeadControlRepository(this.db, session));
      });
      return result;
    } finally {
      await session.endSession();
      await this.locks.deleteMany({ _id: { $in: lockKeys }, owner });
    }
  }

  private options(): { session?: ClientSession } {
    return this.session ? { session: this.session } : {};
  }

  private async acquireLocks(keys: readonly string[], owner: string): Promise<void> {
    for (const key of keys) {
      for (;;) {
        const now = new Date();
        try {
          const lock = await this.locks.findOneAndUpdate(
            { _id: key, $or: [{ expires_at: { $lte: now } }, { owner }] },
            { $set: { owner, expires_at: new Date(now.getTime() + 30_000) } },
            { upsert: true, returnDocument: 'after' },
          );
          if (lock?.owner === owner) break;
        } catch (error: unknown) {
          if (!(error instanceof Error) || !/duplicate key/i.test(error.message)) throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
  }
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
