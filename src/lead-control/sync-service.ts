import { normalizeSalesRecord, RawSalesRecord } from './payment-sales-source';
import { Campaign } from './models';
import { phnomPenhBusinessDate } from './business-time';

export interface SalesSyncCursor {
  updatedAt: Date;
  saleId: string;
}

export interface SalesSyncSource {
  listSalesAfter(cursor: SalesSyncCursor | null, limit: number): Promise<RawSalesRecord[]>;
}

export interface LeadForSaleAttribution {
  id: string;
  normalizedPhone: string;
  occurredAt: Date;
  campaignId: string | null;
}

export interface SalesProjection {
  saleId: string;
  status: string;
  normalizedPhone: string;
  bookingDate: Date;
  completedDate: Date | null;
  cancelledDate: Date | null;
  updatedAt: Date;
  campaignId: string | null;
  attributedLeadId: string | null;
  attributionKind: 'automatic' | 'manual' | 'unmatched';
  attributedAt: Date | null;
}

/** Persistence boundary: tests inject it and production keeps all writes inside Lead Control. */
export interface SalesProjectionRepository {
  getSalesSyncCursor(): Promise<SalesSyncCursor | null>;
  saveSalesSyncCursor(cursor: SalesSyncCursor): Promise<void>;
  getSaleProjection(saleId: string): Promise<SalesProjection | null>;
  saveSaleProjection(sale: SalesProjection): Promise<void>;
  recordMalformedSale(saleId: string | null, reason: string): Promise<void>;
  findMostRecentLeadBefore(phone: string, bookingDate: Date): Promise<LeadForSaleAttribution | null>;
  appendSalesAudit(action: string, actor: string, saleId: string): Promise<void>;
  getCampaign(id: string): Promise<Campaign | null>;
  runSalesAtomic<T>(keys: readonly string[], operation: (repository: SalesProjectionRepository) => Promise<T>): Promise<T>;
}

export interface SalesSyncResult {
  read: number;
  saved: number;
  malformed: number;
}

export class SyncSalesService {
  constructor(
    private readonly source: SalesSyncSource,
    private readonly repository: SalesProjectionRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly pageSize = 500,
  ) {}

  async sync(): Promise<SalesSyncResult> {
    if (!Number.isInteger(this.pageSize) || this.pageSize <= 0) throw new RangeError('pageSize must be a positive integer');
    let cursor = await this.repository.getSalesSyncCursor();
    let read = 0;
    let saved = 0;
    let malformed = 0;

    while (true) {
      const rows = await this.source.listSalesAfter(cursor, this.pageSize);
      if (rows.length === 0) break;
      read += rows.length;
      let nextCursor = cursor;

      for (const row of rows) {
        const normalized = normalizeSalesRecord(row);
        if (!normalized.ok) {
          malformed++;
          await this.repository.recordMalformedSale(normalized.saleId, normalized.reason);
          nextCursor = laterCursor(nextCursor, cursorFromRaw(row));
          continue;
        }

        await this.repository.runSalesAtomic([`sale:${normalized.sale.saleId}`], async (repository) => {
          const existing = await repository.getSaleProjection(normalized.sale.saleId);
          const attribution = existing?.campaignId !== null && existing !== null
            ? frozenAttribution(existing)
            : await this.resolveAttribution(repository, normalized.sale.normalizedPhone, normalized.sale.bookingDate);
          await repository.saveSaleProjection({ ...normalized.sale, ...attribution });
        });
        saved++;
        nextCursor = laterCursor(nextCursor, { updatedAt: normalized.sale.updatedAt, saleId: normalized.sale.saleId });
      }

      if (!nextCursor || sameCursor(cursor, nextCursor)) {
        if (rows.length < this.pageSize) break;
        throw new Error('sales source page did not advance the deterministic cursor');
      }
      await this.repository.saveSalesSyncCursor(nextCursor);
      cursor = nextCursor;
      if (rows.length < this.pageSize) break;
    }
    return { read, saved, malformed };
  }

  /** Manual resolution never reaches Payment Tracker; it only updates the local projection plus audit log. */
  async manuallyAttribute(saleId: string, campaignId: string, actor: string): Promise<void> {
    if (campaignId.trim().length === 0) throw new RangeError('campaignId is required');
    const normalizedCampaignId = campaignId.trim();
    await this.repository.runSalesAtomic([`campaign:${normalizedCampaignId}`, `sale:${saleId}`], async (repository) => {
      const sale = await repository.getSaleProjection(saleId);
      if (!sale) throw new Error('sale projection not found');
      if (sale.campaignId !== null) throw new Error('sale attribution is frozen');
      const campaign = await repository.getCampaign(normalizedCampaignId);
      if (!campaign) throw new Error('campaign not found');
      const bookingDate = phnomPenhBusinessDate(sale.bookingDate);
      if (!bookingDate || campaign.status === 'draft' || campaign.startsOn > bookingDate || (campaign.endsOn !== null && bookingDate > campaign.endsOn)) {
        throw new Error('campaign is not applicable to the sale booking date');
      }
      await repository.saveSaleProjection({
        ...sale,
        campaignId: normalizedCampaignId,
        attributedLeadId: null,
        attributionKind: 'manual',
        attributedAt: this.now(),
      });
      await repository.appendSalesAudit('sale.manually_attributed', actor, saleId);
    });
  }

  private async resolveAttribution(repository: SalesProjectionRepository, phone: string, bookingDate: Date): Promise<Pick<SalesProjection, 'campaignId' | 'attributedLeadId' | 'attributionKind' | 'attributedAt'>> {
    const lead = await repository.findMostRecentLeadBefore(phone, bookingDate);
    if (!lead || lead.campaignId === null) {
      return { campaignId: null, attributedLeadId: null, attributionKind: 'unmatched', attributedAt: null };
    }
    return {
      campaignId: lead.campaignId,
      attributedLeadId: lead.id,
      attributionKind: 'automatic',
      attributedAt: this.now(),
    };
  }
}

function frozenAttribution(existing: SalesProjection): Pick<SalesProjection, 'campaignId' | 'attributedLeadId' | 'attributionKind' | 'attributedAt'> {
  return {
    campaignId: existing.campaignId,
    attributedLeadId: existing.attributedLeadId,
    attributionKind: existing.attributionKind,
    attributedAt: existing.attributedAt,
  };
}

function cursorFromRaw(row: RawSalesRecord): SalesSyncCursor | null {
  return row.updated_at instanceof Date
    && !Number.isNaN(row.updated_at.getTime())
    && typeof row.sale_id === 'string'
    && row.sale_id.trim().length > 0
    ? { updatedAt: row.updated_at, saleId: row.sale_id.trim() }
    : null;
}

function laterCursor(current: SalesSyncCursor | null, candidate: SalesSyncCursor | null): SalesSyncCursor | null {
  if (!candidate) return current;
  if (!current || candidate.updatedAt > current.updatedAt || (candidate.updatedAt.getTime() === current.updatedAt.getTime() && candidate.saleId > current.saleId)) {
    return candidate;
  }
  return current;
}

function sameCursor(left: SalesSyncCursor | null, right: SalesSyncCursor): boolean {
  return left !== null && left.updatedAt.getTime() === right.updatedAt.getTime() && left.saleId === right.saleId;
}
