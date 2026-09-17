import test from 'node:test';
import assert from 'node:assert/strict';
import { Campaign, ForecastRevision, SpendRecord } from '../../src/lead-control/models';
import { SalesProjection } from '../../src/lead-control/sync-service';
import { SummaryDataRepository, SummaryService } from '../../src/lead-control/summary-service';

const campaign: Campaign = {
  id: 'campaign-1', name: 'September', pageId: 'page-a', startsOn: '2026-09-10', endsOn: '2026-09-25', status: 'active',
  createdAt: new Date('2026-09-01T00:00:00.000Z'), createdBy: 'developer', archivedAt: null, archivedBy: null,
};

const baseline: ForecastRevision = {
  id: 'baseline', campaignId: campaign.id, month: '2026-09', monthlyBudgetCents: 300_000,
  costPerMessageCents: 1_000, messageToPhoneRate: 0.5, phoneToVisitRate: 0.5, visitToBookingRate: 0.5, cancellationRate: 0.2,
  revisionNumber: 1, kind: 'baseline', status: 'approved', createdAt: new Date('2026-09-01T00:00:00.000Z'), createdBy: 'developer',
  approvedAt: new Date('2026-09-01T00:00:00.000Z'), approvedBy: 'developer',
};

const latest: ForecastRevision = { ...baseline, id: 'latest', revisionNumber: 2, kind: 'revision', monthlyBudgetCents: 310_000, createdAt: new Date('2026-09-15T00:00:00.000Z') };

function spend(input: Partial<SpendRecord> = {}): SpendRecord {
  return {
    id: 'spend-1', campaignId: campaign.id, month: '2026-09', businessDate: '2026-09-15', amountCents: 70_000,
    mode: 'daily', status: 'active', createdAt: new Date(), createdBy: 'developer', archivedAt: null, archivedBy: null, ...input,
  };
}

function sale(input: Partial<SalesProjection> = {}): SalesProjection {
  return {
    saleId: 'sale-1', status: 'BOOKED', normalizedPhone: '+85512345678', bookingDate: new Date('2026-09-15T03:00:00.000Z'),
    completedDate: null, cancelledDate: null, updatedAt: new Date('2026-09-15T04:00:00.000Z'), campaignId: campaign.id,
    attributedLeadId: 'lead-1', attributionKind: 'automatic', attributedAt: new Date(), ...input,
  };
}

class MemorySummaryRepository implements SummaryDataRepository {
  constructor(
    readonly campaigns = [campaign], readonly revisions = [baseline, latest], readonly spends = [spend(), spend({ id: 'future', businessDate: '2026-09-21', amountCents: 10_000 })],
    readonly summaries = [{ date: '2026-09-15', campaign_id: campaign.id, normalized_metrics: { messages: 80, valid_phone_leads: 30, completed_property_visits: 10 } }],
    readonly sales = [sale(), sale({ saleId: 'cancelled', status: 'CANCELLED', cancelledDate: new Date('2026-09-18T03:00:00.000Z') })],
    readonly cursor: { updatedAt: Date; saleId: string } | null = { updatedAt: new Date('2026-09-19T00:00:00.000Z'), saleId: 'cancelled' },
    readonly malformed = 1,
  ) {}
  async getCampaign(id: string): Promise<Campaign | null> { return this.campaigns.find((value) => value.id === id) ?? null; }
  async listRevisions(campaignId: string, month?: string): Promise<ForecastRevision[]> { return this.revisions.filter((value) => value.campaignId === campaignId && (month === undefined || value.month === month)); }
  async listSpend(campaignId: string, month?: string): Promise<SpendRecord[]> { return this.spends.filter((value) => value.campaignId === campaignId && (month === undefined || value.month === month)); }
  async listDailySummaries(campaignId: string, month: string): Promise<readonly { date: string; campaign_id?: string | null; normalized_metrics?: { messages: number; valid_phone_leads: number; completed_property_visits: number } }[]> { return this.summaries.filter((value) => value.campaign_id === campaignId && value.date.startsWith(month)); }
  async listSalesProjections(campaignId: string): Promise<SalesProjection[]> { return this.sales.filter((value) => value.campaignId === campaignId); }
  async listUnmatchedSales(): Promise<SalesProjection[]> { return this.sales.filter((value) => value.attributionKind === 'unmatched'); }
  async getSalesSyncCursor(): Promise<{ updatedAt: Date; saleId: string } | null> { return this.cursor; }
  async countMalformedSales(): Promise<number> { return this.malformed; }
}

test('builds a deterministic monthly summary with active-day planned spend and independent funnel efficiency', async () => {
  const result = await new SummaryService(new MemorySummaryRepository()).monthly({ campaignId: campaign.id, month: '2026-09', asOf: '2026-09-20' });

  assert.deepEqual(result.pacing, { plannedSpendCents: 113_667, actualSpendCents: 70_000, remainingBudgetCents: 240_000, varianceCents: -43_667, state: 'Behind' });
  assert.equal(result.fullMonthForecast.messages, 310);
  assert.equal(result.spendAdjustedExpected.messages, 70);
  assert.deepEqual(result.actualFunnel, { messages: 80, phoneLeads: 30, visits: 10, grossBookings: 2, cancellations: 1, netBookings: 1 });
  assert.equal(result.stages.messages.variance, 10);
  assert.equal(result.stages.messages.costPerResultCents, 875);
  assert.equal(result.stages.messages.status, 'Good');
  assert.equal(result.stages.cancellations.status, 'Bad');
  assert.equal(result.provisional, true);
  assert.equal(result.revisions.baseline?.id, 'baseline');
  assert.equal(result.revisions.latest?.id, 'latest');
  assert.deepEqual(result.revisions.history.map((value) => value.id), ['baseline', 'latest']);
});

test('returns pending stage statuses when summaries or sales do not provide a denominator', async () => {
  const repository = new MemorySummaryRepository([campaign], [baseline], [spend()], [], [], null, 0);
  const result = await new SummaryService(repository).monthly({ campaignId: campaign.id, month: '2026-09', asOf: '2026-09-20' });

  assert.equal(result.stages.messages.actual, null);
  assert.equal(result.stages.messages.status, 'Pending');
  assert.equal(result.stages.cancellations.actual, null);
  assert.equal(result.stages.cancellations.status, 'Pending');
  assert.equal(result.syncHealth.status, 'Pending');
});

test('keeps a zero-result funnel stage pending instead of assigning an outcome score', async () => {
  const repository = new MemorySummaryRepository(
    [campaign], [baseline], [spend()],
    [{ date: '2026-09-15', campaign_id: campaign.id, normalized_metrics: { messages: 0, valid_phone_leads: 0, completed_property_visits: 0 } }],
    [sale()],
  );
  const result = await new SummaryService(repository).monthly({ campaignId: campaign.id, month: '2026-09', asOf: '2026-09-20' });

  assert.equal(result.stages.messages.costPerResultCents, null);
  assert.equal(result.stages.messages.status, 'Pending');
  assert.equal(result.stages.phoneLeads.status, 'Pending');
});

test('rejects impossible business dates instead of rolling them into another month', async () => {
  await assert.rejects(
    new SummaryService(new MemorySummaryRepository()).monthly({ campaignId: campaign.id, month: '2026-09', asOf: '2026-09-31' }),
    /asOf must be YYYY-MM-DD/,
  );
});

test('presents cohort and cancellation-event views without changing frozen booking attribution', async () => {
  const repository = new MemorySummaryRepository();
  const service = new SummaryService(repository);

  assert.deepEqual((await service.cancellations({ campaignId: campaign.id, month: '2026-09', view: 'cohort' })).map((value) => value.saleId), ['cancelled']);
  assert.deepEqual((await service.cancellations({ campaignId: campaign.id, month: '2026-09', view: 'event' })).map((value) => value.saleId), ['cancelled']);
  assert.deepEqual(await service.unmatchedSales(), []);
  assert.deepEqual(await service.syncHealth('2026-09-20'), { status: 'Healthy', cursor: repository.cursor, ageHours: 24, unmatchedSales: 0, malformedSales: 1 });
});

test('uses Phnom Penh calendar dates for cohort and cancellation-event month views at the UTC boundary', async () => {
  const boundary = sale({
    saleId: 'local-october', status: 'CANCELLED',
    bookingDate: new Date('2026-09-30T18:00:00.000Z'),
    cancelledDate: new Date('2026-09-30T18:00:00.000Z'),
  });
  const service = new SummaryService(new MemorySummaryRepository([campaign], [baseline], [], [], [boundary]));

  assert.deepEqual((await service.cancellations({ campaignId: campaign.id, month: '2026-09', view: 'cohort' })).map((value) => value.saleId), []);
  assert.deepEqual((await service.cancellations({ campaignId: campaign.id, month: '2026-10', view: 'cohort' })).map((value) => value.saleId), ['local-october']);
  assert.deepEqual((await service.cancellations({ campaignId: campaign.id, month: '2026-09', view: 'event' })).map((value) => value.saleId), []);
  assert.deepEqual((await service.cancellations({ campaignId: campaign.id, month: '2026-10', view: 'event' })).map((value) => value.saleId), ['local-october']);
});

test('counts a cancellation against the booking cohort only on or after its Phnom Penh cancellation date', async () => {
  const delayedCancellation = sale({
    status: 'CANCELLED', bookingDate: new Date('2026-09-10T03:00:00.000Z'), cancelledDate: new Date('2026-09-25T03:00:00.000Z'),
  });
  const service = new SummaryService(new MemorySummaryRepository([campaign], [baseline], [spend()], [], [delayedCancellation]));

  assert.deepEqual((await service.monthly({ campaignId: campaign.id, month: '2026-09', asOf: '2026-09-20' })).actualFunnel, {
    messages: null, phoneLeads: null, visits: null, grossBookings: 1, cancellations: 0, netBookings: 1,
  });
  assert.deepEqual((await service.monthly({ campaignId: campaign.id, month: '2026-09', asOf: '2026-09-30' })).actualFunnel, {
    messages: null, phoneLeads: null, visits: null, grossBookings: 1, cancellations: 1, netBookings: 0,
  });
});
