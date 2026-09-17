import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  RawSalesRecord,
  validateSalesSourcePrivileges,
} from '../../src/lead-control/payment-sales-source';
import { DAILY_SUMMARY_INDEXES, saleAttributionLeadFilter, SALES_PROJECTION_INDEXES } from '../../src/lead-control/repository';
import {
  LeadForSaleAttribution,
  SalesProjection,
  SalesProjectionRepository,
  SalesSyncCursor,
  SalesSyncSource,
  SyncSalesService,
} from '../../src/lead-control/sync-service';

class InMemorySalesRepository implements SalesProjectionRepository {
  cursor: SalesSyncCursor | null = null;
  readonly sales = new Map<string, SalesProjection>();
  readonly malformed: Array<{ saleId: string | null; reason: string }> = [];
  readonly audits: Array<{ action: string; actor: string; saleId: string }> = [];
  leads: LeadForSaleAttribution[] = [];

  async getSalesSyncCursor(): Promise<SalesSyncCursor | null> { return this.cursor; }
  async saveSalesSyncCursor(cursor: SalesSyncCursor): Promise<void> { this.cursor = cursor; }
  async getSaleProjection(saleId: string): Promise<SalesProjection | null> { return this.sales.get(saleId) ?? null; }
  async saveSaleProjection(sale: SalesProjection): Promise<void> { this.sales.set(sale.saleId, sale); }
  async recordMalformedSale(saleId: string | null, reason: string): Promise<void> { this.malformed.push({ saleId, reason }); }
  async findMostRecentLeadBefore(phone: string, bookingDate: Date): Promise<LeadForSaleAttribution | null> {
    return this.leads
      .filter((lead) => lead.normalizedPhone === phone && lead.occurredAt.getTime() < bookingDate.getTime() && lead.campaignId !== null)
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())[0] ?? null;
  }
  async appendSalesAudit(action: string, actor: string, saleId: string): Promise<void> { this.audits.push({ action, actor, saleId }); }
  async runSalesAtomic<T>(_keys: readonly string[], operation: (repository: SalesProjectionRepository) => Promise<T>): Promise<T> { return operation(this); }
}

class ArraySalesSource implements SalesSyncSource {
  constructor(private readonly rows: RawSalesRecord[]) {}

  async listSalesAfter(cursor: SalesSyncCursor | null): Promise<RawSalesRecord[]> {
    return this.rows.filter((row) => {
      const updatedAt = row.updated_at;
      const saleId = row.sale_id;
      if (!(updatedAt instanceof Date) || typeof saleId !== 'string' || cursor === null) return true;
      return updatedAt > cursor.updatedAt || (updatedAt.getTime() === cursor.updatedAt.getTime() && saleId > cursor.saleId);
    });
  }
}

function sale(overrides: Partial<RawSalesRecord> = {}): RawSalesRecord {
  return {
    sale_id: 'sale-1',
    status: 'BOOKED',
    phone: ['012 345 678'],
    start_date: new Date('2026-09-10T09:00:00.000Z'),
    completed_date: null,
    cancelled_date: null,
    updated_at: new Date('2026-09-10T10:00:00.000Z'),
    ...overrides,
  };
}

test('incremental sync normalizes a sale, attributes its latest earlier lead, and advances its sale-id cursor', async () => {
  const repository = new InMemorySalesRepository();
  repository.leads = [
    { id: 'lead-old', normalizedPhone: '+85512345678', occurredAt: new Date('2026-09-01T00:00:00.000Z'), campaignId: 'campaign-old' },
    { id: 'lead-new', normalizedPhone: '+85512345678', occurredAt: new Date('2026-09-09T00:00:00.000Z'), campaignId: 'campaign-new' },
    { id: 'lead-after', normalizedPhone: '+85512345678', occurredAt: new Date('2026-09-11T00:00:00.000Z'), campaignId: 'campaign-after' },
  ];
  const service = new SyncSalesService(new ArraySalesSource([sale()]), repository, () => new Date('2026-09-12T00:00:00.000Z'));

  assert.deepEqual(await service.sync(), { read: 1, saved: 1, malformed: 0 });
  assert.deepEqual(repository.sales.get('sale-1'), {
    saleId: 'sale-1',
    status: 'BOOKED',
    normalizedPhone: '+85512345678',
    bookingDate: new Date('2026-09-10T09:00:00.000Z'),
    completedDate: null,
    cancelledDate: null,
    updatedAt: new Date('2026-09-10T10:00:00.000Z'),
    campaignId: 'campaign-new',
    attributedLeadId: 'lead-new',
    attributionKind: 'automatic',
    attributedAt: new Date('2026-09-12T00:00:00.000Z'),
  });
  assert.deepEqual(repository.cursor, { updatedAt: new Date('2026-09-10T10:00:00.000Z'), saleId: 'sale-1' });
});

test('a repeated row is idempotent while a later delayed cancellation refreshes source facts without rewriting frozen attribution', async () => {
  const repository = new InMemorySalesRepository();
  repository.leads = [{ id: 'lead-1', normalizedPhone: '+85512345678', occurredAt: new Date('2026-09-09T00:00:00.000Z'), campaignId: 'campaign-original' }];
  const first = sale();
  const service = new SyncSalesService(new ArraySalesSource([first]), repository);
  await service.sync();

  assert.deepEqual(await service.sync(), { read: 0, saved: 0, malformed: 0 });
  repository.leads = [{ id: 'lead-rewritten', normalizedPhone: '+85512345678', occurredAt: new Date('2026-09-09T12:00:00.000Z'), campaignId: 'campaign-edited' }];
  const cancellation = sale({ status: 'CANCELLED', cancelled_date: new Date('2026-09-13T08:00:00.000Z'), updated_at: new Date('2026-09-13T09:00:00.000Z') });
  const refresh = new SyncSalesService(new ArraySalesSource([cancellation]), repository);

  assert.deepEqual(await refresh.sync(), { read: 1, saved: 1, malformed: 0 });
  assert.equal(repository.sales.get('sale-1')?.status, 'CANCELLED');
  assert.deepEqual(repository.sales.get('sale-1')?.cancelledDate, new Date('2026-09-13T08:00:00.000Z'));
  assert.equal(repository.sales.get('sale-1')?.campaignId, 'campaign-original');
  assert.equal(repository.sales.get('sale-1')?.attributedLeadId, 'lead-1');
});

test('malformed source rows are recorded and unmatched sales remain reconcilable until a Lead Control manual attribution', async () => {
  const repository = new InMemorySalesRepository();
  const source = new ArraySalesSource([
    sale({ sale_id: 'bad-sale', phone: ['not-a-phone'], updated_at: new Date('2026-09-10T10:00:00.000Z') }),
    sale({ sale_id: 'unmatched-sale', phone: '098 765 432', updated_at: new Date('2026-09-10T11:00:00.000Z') }),
  ]);
  const service = new SyncSalesService(source, repository, () => new Date('2026-09-12T00:00:00.000Z'));

  assert.deepEqual(await service.sync(), { read: 2, saved: 1, malformed: 1 });
  assert.deepEqual(repository.malformed, [{ saleId: 'bad-sale', reason: 'no_valid_phone' }]);
  assert.equal(repository.sales.get('unmatched-sale')?.campaignId, null);
  assert.equal(repository.sales.get('unmatched-sale')?.attributionKind, 'unmatched');

  await service.manuallyAttribute('unmatched-sale', 'campaign-manual', 'manager');
  assert.equal(repository.sales.get('unmatched-sale')?.campaignId, 'campaign-manual');
  assert.equal(repository.sales.get('unmatched-sale')?.attributionKind, 'manual');
  assert.deepEqual(repository.audits, [{ action: 'sale.manually_attributed', actor: 'manager', saleId: 'unmatched-sale' }]);
});

test('sales-source privilege validation rejects credentials broader than ar_tracker.sales find/listIndexes', () => {
  assert.equal(validateSalesSourcePrivileges([
    { resource: { db: 'ar_tracker', collection: 'sales' }, actions: ['find', 'listIndexes'] },
  ]).ok, true);
  assert.equal(validateSalesSourcePrivileges([
    { resource: { db: 'ar_tracker', collection: '' }, actions: ['find', 'listIndexes'] },
  ]).ok, false);
  assert.equal(validateSalesSourcePrivileges([
    { resource: { db: 'ar_tracker', collection: 'sales' }, actions: ['find', 'update'] },
  ]).ok, false);
});

test('sales connector ignores namespace override environment variables and permits only the fixed sales namespace', () => {
  const output = execFileSync(process.execPath, [
    '-r', './tests/register.js',
    '-e', "const source = require('./src/lead-control/payment-sales-source'); process.stdout.write(JSON.stringify({ db: source.SALES_SOURCE_DB, collection: source.SALES_SOURCE_COLLECTION, rogue: source.validateSalesSourcePrivileges([{ resource: { db: 'rogue', collection: 'orders' }, actions: ['find', 'listIndexes'] }]).ok }));",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LEAD_CONTROL_SALES_DATABASE_NAME: 'rogue',
      LEAD_CONTROL_SALES_COLLECTION: 'orders',
    },
    encoding: 'utf8',
  });

  assert.deepEqual(JSON.parse(output), { db: 'ar_tracker', collection: 'sales', rogue: false });
});

test('lead attribution queries the persisted normalized phone key and projection indexes support cancellation event reporting', () => {
  assert.deepEqual(
    saleAttributionLeadFilter('+85512345678', new Date('2026-09-10T09:00:00.000Z')),
    {
      normalized_phone: '+85512345678',
      campaign_id: { $type: 'string' },
      deleted: { $ne: true },
      date: { $lt: '2026-09-10' },
    },
  );
  assert.equal(
    SALES_PROJECTION_INDEXES.some((index) => index.name === 'status_cancellation_event_lookup'
      && JSON.stringify(index.key) === JSON.stringify({ status: 1, cancelled_date: 1 })),
    true,
  );
  assert.equal(
    DAILY_SUMMARY_INDEXES.some((index) => index.name === 'campaign_month_summary_lookup'
      && JSON.stringify(index.key) === JSON.stringify({ campaign_id: 1, date: 1 })),
    true,
  );
});
