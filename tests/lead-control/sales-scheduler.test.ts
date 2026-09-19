import test from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '../../src/utils/logger';
import { LeadControlConfig } from '../../src/lead-control/config';
import { RawSalesRecord, SalesReadCollection } from '../../src/lead-control/payment-sales-source';
import {
  LeadForSaleAttribution,
  SalesProjection,
  SalesProjectionRepository,
  SalesSyncCursor,
} from '../../src/lead-control/sync-service';
import {
  CronPort,
  LeadControlSalesScheduler,
  LeadControlSalesSourceConnection,
} from '../../src/scheduler/lead-control-sales-scheduler';

class MemorySalesRepository implements SalesProjectionRepository {
  cursor: SalesSyncCursor | null = null;
  readonly sales = new Map<string, SalesProjection>();
  readonly malformed: Array<{ saleId: string | null; reason: string }> = [];
  async getSalesSyncCursor(): Promise<SalesSyncCursor | null> { return this.cursor; }
  async saveSalesSyncCursor(cursor: SalesSyncCursor): Promise<void> { this.cursor = cursor; }
  async getSaleProjection(saleId: string): Promise<SalesProjection | null> { return this.sales.get(saleId) ?? null; }
  async saveSaleProjection(sale: SalesProjection): Promise<void> { this.sales.set(sale.saleId, sale); }
  async recordMalformedSale(saleId: string | null, reason: string): Promise<void> { this.malformed.push({ saleId, reason }); }
  async findMostRecentLeadBefore(_phone: string, _bookingDate: Date): Promise<LeadForSaleAttribution | null> { return null; }
  async appendSalesAudit(_action: string, _actor: string, _saleId: string): Promise<void> {}
  async getCampaign(_id: string): Promise<null> { return null; }
  async runSalesAtomic<T>(_keys: readonly string[], operation: (repository: SalesProjectionRepository) => Promise<T>): Promise<T> { return operation(this); }
}

class FakeCron implements CronPort {
  expression: string | null = null;
  options: { scheduled: true; timezone: string } | null = null;
  callback: (() => void | Promise<void>) | null = null;
  stops = 0;
  schedule(expression: string, callback: () => void | Promise<void>, options: { scheduled: true; timezone: string }) {
    this.expression = expression;
    this.callback = callback;
    this.options = options;
    return { stop: () => { this.stops++; } };
  }
  async tick(): Promise<void> {
    assert.ok(this.callback);
    await this.callback();
  }
}

class FakeSourceConnection implements LeadControlSalesSourceConnection {
  connects = 0;
  disconnects = 0;
  connected = false;
  reads = 0;
  connectError: Error | null = null;
  rows: RawSalesRecord[] = [];
  readBarrier: Promise<void> | null = null;
  async connect(): Promise<void> {
    this.connects++;
    if (this.connectError) throw this.connectError;
    this.connected = true;
  }
  async disconnect(): Promise<void> { this.disconnects++; this.connected = false; }
  isConnected(): boolean { return this.connected; }
  collection(): SalesReadCollection {
    const source = this;
    return {
      find: () => ({
        toArray: async () => {
          source.reads++;
          if (source.readBarrier) await source.readBarrier;
          return source.rows;
        },
      }),
    };
  }
}

function config(overrides: Partial<LeadControlConfig> = {}): LeadControlConfig {
  return { writesEnabled: false, syncEnabled: true, syncIntervalMinutes: 15, ...overrides };
}

function validSale(): RawSalesRecord {
  return {
    sale_id: 'sale-secret-1', status: 'BOOKED', phone: '012 345 678',
    start_date: new Date('2026-09-10T09:00:00.000Z'), completed_date: null,
    cancelled_date: null, updated_at: new Date('2026-09-10T10:00:00.000Z'),
  };
}

// Production mutation caught: disabled startup still registers cron or opens the external connection.
test('disabled Lead Control sync registers nothing and manual trigger opens nothing', async () => {
  const cron = new FakeCron();
  const source = new FakeSourceConnection();
  const scheduler = new LeadControlSalesScheduler(config({ syncEnabled: false }), source, new MemorySalesRepository(), cron);

  scheduler.start();
  assert.equal(cron.callback, null);
  assert.equal(await scheduler.triggerNow(), null);
  assert.equal(source.connects, 0);
  await scheduler.stop();
  assert.equal(source.disconnects, 0);
});

// Production mutation caught: enabled scheduler uses the wrong cadence/timezone or logs sensitive rows.
test('enabled Lead Control sync schedules in Cambodia and logs only aggregate counts', async (t) => {
  const cron = new FakeCron();
  const source = new FakeSourceConnection();
  source.rows = [validSale()];
  const repository = new MemorySalesRepository();
  const messages: string[] = [];
  t.mock.method(Logger, 'info', (message: string) => { messages.push(message); });
  const scheduler = new LeadControlSalesScheduler(config(), source, repository, cron);

  scheduler.start();
  assert.equal(cron.expression, '*/15 * * * *');
  assert.deepEqual(cron.options, { scheduled: true, timezone: 'Asia/Phnom_Penh' });
  await cron.tick();
  assert.equal(repository.sales.has('sale-secret-1'), true);
  assert.equal(messages.some((message) => /read=1 saved=1 malformed=0/.test(message)), true);
  assert.equal(messages.some((message) => /sale-secret-1|012 345 678|\+85512345678/.test(message)), false);
});

// Production mutation caught: concurrent ticks perform duplicate source reads instead of sharing one in-flight run.
test('Lead Control sync is single-flight across overlapping scheduled and manual triggers', async () => {
  const cron = new FakeCron();
  const source = new FakeSourceConnection();
  source.rows = [validSale()];
  let release!: () => void;
  source.readBarrier = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new LeadControlSalesScheduler(config(), source, new MemorySalesRepository(), cron);
  scheduler.start();

  const scheduled = cron.tick();
  while (source.reads === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  const manual = scheduler.triggerNow();
  assert.equal(source.connects, 1);
  assert.equal(source.reads, 1);
  release();
  await Promise.all([scheduled, manual]);
  assert.equal(source.reads, 1);
});

// Production mutation caught: one source failure rejects the cron callback and can terminate future scheduling.
test('Lead Control scheduled tick contains and logs source failures', async (t) => {
  const cron = new FakeCron();
  const source = new FakeSourceConnection();
  source.connectError = new Error('source unavailable');
  const errors: Array<{ message: string; error?: Error }> = [];
  t.mock.method(Logger, 'error', (message: string, error?: Error) => { errors.push({ message, ...(error ? { error } : {}) }); });
  const scheduler = new LeadControlSalesScheduler(config(), source, new MemorySalesRepository(), cron);
  scheduler.start();

  await assert.doesNotReject(cron.tick());
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'Lead Control sales sync tick failed');
  assert.equal(errors[0].error?.message, 'source unavailable');
});

// Production mutation caught: shutdown leaves cron or the external sales client alive.
test('Lead Control shutdown stops cron, waits for the run, and disconnects the source', async () => {
  const cron = new FakeCron();
  const source = new FakeSourceConnection();
  const scheduler = new LeadControlSalesScheduler(config({ syncIntervalMinutes: 60 }), source, new MemorySalesRepository(), cron);
  scheduler.start();
  await scheduler.triggerNow();

  assert.equal(cron.expression, '0 * * * *');
  await scheduler.stop();
  assert.equal(cron.stops, 1);
  assert.equal(source.disconnects, 1);
  assert.equal(source.connected, false);
});
