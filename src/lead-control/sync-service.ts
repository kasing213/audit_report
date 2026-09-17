import { normalizeSalesRecord, RawSalesRecord } from './payment-sales-source';

export interface SalesSyncCursor {
  updatedAt: Date;
  saleId: string;
}

export interface SalesSyncSource {
  listSalesAfter(cursor: SalesSyncCursor | null): Promise<RawSalesRecord[]>;
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
  ) {}

  async sync(): Promise<SalesSyncResult> {
    const cursor = await this.repository.getSalesSyncCursor();
    const rows = await this.source.listSalesAfter(cursor);
    let saved = 0;
    let malformed = 0;
    let nextCursor = cursor;

    for (const row of rows) {
      const normalized = normalizeSalesRecord(row);
      if (!normalized.ok) {
        malformed++;
        await this.repository.recordMalformedSale(normalized.saleId, normalized.reason);
        nextCursor = laterCursor(nextCursor, cursorFromRaw(row));
        continue;
      }

      const existing = await this.repository.getSaleProjection(normalized.sale.saleId);
      const attribution = existing?.campaignId !== null && existing !== null
        ? frozenAttribution(existing)
        : await this.resolveAttribution(normalized.sale.normalizedPhone, normalized.sale.bookingDate);
      await this.repository.saveSaleProjection({ ...normalized.sale, ...attribution });
      saved++;
      nextCursor = laterCursor(nextCursor, { updatedAt: normalized.sale.updatedAt, saleId: normalized.sale.saleId });
    }

    if (nextCursor && (cursor === null || nextCursor.updatedAt.getTime() !== cursor.updatedAt.getTime() || nextCursor.saleId !== cursor.saleId)) {
      await this.repository.saveSalesSyncCursor(nextCursor);
    }
    return { read: rows.length, saved, malformed };
  }

  /** Manual resolution never reaches Payment Tracker; it only updates the local projection plus audit log. */
  async manuallyAttribute(saleId: string, campaignId: string, actor: string): Promise<void> {
    if (campaignId.trim().length === 0) throw new RangeError('campaignId is required');
    await this.repository.runSalesAtomic([`sale:${saleId}`], async (repository) => {
      const sale = await repository.getSaleProjection(saleId);
      if (!sale) throw new Error('sale projection not found');
      if (sale.campaignId !== null) throw new Error('sale attribution is frozen');
      await repository.saveSaleProjection({
        ...sale,
        campaignId: campaignId.trim(),
        attributedLeadId: null,
        attributionKind: 'manual',
        attributedAt: this.now(),
      });
      await repository.appendSalesAudit('sale.manually_attributed', actor, saleId);
    });
  }

  private async resolveAttribution(phone: string, bookingDate: Date): Promise<Pick<SalesProjection, 'campaignId' | 'attributedLeadId' | 'attributionKind' | 'attributedAt'>> {
    const lead = await this.repository.findMostRecentLeadBefore(phone, bookingDate);
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
