import { Campaign, ForecastRevision, SpendRecord } from './models';
import {
  classifyCancellationRate,
  classifyCostPerResult,
  classifyOutcome,
  compareBudgetPacing,
  costPerResultCents,
  forecastFromBudget,
  rate,
} from './forecast';
import { FunnelForecast, LeadControlStatus } from './types';
import { SalesProjection, SalesSyncCursor } from './sync-service';
import { phnomPenhBusinessDate } from './business-time';

export interface SummaryDailyDocument {
  date: string;
  campaign_id?: string | null;
  normalized_metrics?: {
    messages: number;
    valid_phone_leads: number;
    completed_property_visits: number;
  };
}

/** Read-only boundary for summary data; production and unit-test adapters stay interchangeable. */
export interface SummaryDataRepository {
  getCampaign(id: string): Promise<Campaign | null>;
  listRevisions(campaignId: string, month?: string): Promise<ForecastRevision[]>;
  listSpend(campaignId: string, month?: string): Promise<SpendRecord[]>;
  listDailySummaries(campaignId: string, month: string): Promise<readonly SummaryDailyDocument[]>;
  listSalesProjections(campaignId: string): Promise<SalesProjection[]>;
  listUnmatchedSales(): Promise<SalesProjection[]>;
  getSalesSyncCursor(): Promise<SalesSyncCursor | null>;
  countMalformedSales(): Promise<number>;
}

export interface MonthlySummaryInput {
  campaignId: string;
  month: string;
  /** YYYY-MM-DD in the business timezone. */
  asOf: string;
}

export type CancellationView = 'cohort' | 'event';

export interface CancellationQuery {
  campaignId: string;
  month: string;
  view: CancellationView;
}

export interface FunnelActuals {
  messages: number | null;
  phoneLeads: number | null;
  visits: number | null;
  grossBookings: number | null;
  cancellations: number | null;
  netBookings: number | null;
}

export interface StageSummary {
  forecast: number;
  expected: number;
  actual: number | null;
  variance: number | null;
  costPerResultCents: number | null;
  targetCostPerResultCents: number;
  outcomeStatus: LeadControlStatus;
  costStatus: LeadControlStatus;
}

export interface MonthlySummary {
  campaign: Campaign;
  month: string;
  asOf: string;
  pacing: {
    plannedSpendCents: number;
    actualSpendCents: number;
    remainingBudgetCents: number;
    varianceCents: number;
    state: 'Ahead' | 'On pace' | 'Behind';
  };
  fullMonthForecast: FunnelForecast;
  spendAdjustedExpected: FunnelForecast;
  actualFunnel: FunnelActuals;
  stages: Record<'messages' | 'phoneLeads' | 'visits' | 'grossBookings' | 'cancellations' | 'netBookings', StageSummary>;
  provisional: boolean;
  revisions: { baseline: ForecastRevision | null; latest: ForecastRevision | null; history: ForecastRevision[] };
  syncHealth: SyncHealth;
}

export interface SyncHealth {
  status: 'Healthy' | 'Stale' | 'Pending';
  cursor: SalesSyncCursor | null;
  ageHours: number | null;
  unmatchedSales: number;
  malformedSales: number;
}

export class SummaryService {
  constructor(
    private readonly repository: SummaryDataRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async monthly(input: MonthlySummaryInput): Promise<MonthlySummary> {
    validateMonth(input.month);
    validateBusinessDate(input.asOf, 'asOf');
    const campaign = await this.repository.getCampaign(input.campaignId);
    if (!campaign) throw new Error('campaign not found');
    const revisions = (await this.repository.listRevisions(campaign.id, input.month)).sort(compareRevision);
    const baseline = revisions.find((value) => value.kind === 'baseline' && value.status === 'approved') ?? null;
    const latest = [...revisions].reverse().find((value) => value.status === 'approved') ?? null;
    if (!latest) throw new Error('approved forecast not found for campaign month');

    const [spends, summaries, sales] = await Promise.all([
      this.repository.listSpend(campaign.id, input.month),
      this.repository.listDailySummaries(campaign.id, input.month),
      this.repository.listSalesProjections(campaign.id),
    ]);
    const actualSpendCents = actualSpendToDate(spends, input.asOf);
    const pacing = compareBudgetPacing({
      monthlyBudgetCents: latest.monthlyBudgetCents,
      activeDays: activeDaysThrough(campaign, input.month, input.asOf),
      daysInMonth: daysInMonth(input.month),
      actualSpendCents,
    });
    const fullMonthForecast = forecastFromBudget({ budgetCents: latest.monthlyBudgetCents, ...latest });
    const spendAdjustedExpected = forecastFromBudget({ budgetCents: actualSpendCents, ...latest });
    const syncHealth = await this.syncHealth();
    const actualFunnel = actuals(summaries, sales, input.month, input.asOf, syncHealth.cursor !== null);
    const targets = stageTargets(latest, fullMonthForecast);
    const stages = buildStages(fullMonthForecast, spendAdjustedExpected, actualFunnel, actualSpendCents, targets, latest.cancellationRate);

    return {
      campaign,
      month: input.month,
      asOf: input.asOf,
      pacing: { ...pacing, remainingBudgetCents: Math.max(0, latest.monthlyBudgetCents - actualSpendCents) },
      fullMonthForecast,
      spendAdjustedExpected,
      actualFunnel,
      stages,
      provisional: isOpenMonth(input.month, input.asOf),
      revisions: { baseline, latest, history: revisions },
      syncHealth,
    };
  }

  async cancellations(query: CancellationQuery): Promise<SalesProjection[]> {
    validateMonth(query.month);
    const sales = await this.repository.listSalesProjections(query.campaignId);
    return sales
      .filter((sale) => sale.status === 'CANCELLED' && phnomPenhBusinessDate(sale.cancelledDate) !== null)
      .filter((sale) => selectedCancellationDate(sale, query.view)?.startsWith(query.month) ?? false)
      .sort((left, right) => {
        const leftDate = selectedCancellationDate(left, query.view)!;
        const rightDate = selectedCancellationDate(right, query.view)!;
        return leftDate.localeCompare(rightDate) || left.saleId.localeCompare(right.saleId);
      });
  }

  async unmatchedSales(): Promise<SalesProjection[]> {
    return (await this.repository.listUnmatchedSales()).sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || left.saleId.localeCompare(right.saleId));
  }

  async syncHealth(): Promise<SyncHealth> {
    const [cursor, unmatchedSales, malformedSales] = await Promise.all([
      this.repository.getSalesSyncCursor(), this.repository.listUnmatchedSales(), this.repository.countMalformedSales(),
    ]);
    if (!cursor) return { status: 'Pending', cursor: null, ageHours: null, unmatchedSales: unmatchedSales.length, malformedSales };
    const ageHours = Math.max(0, (this.now().getTime() - cursor.updatedAt.getTime()) / 3_600_000);
    return { status: ageHours <= 24 ? 'Healthy' : 'Stale', cursor, ageHours, unmatchedSales: unmatchedSales.length, malformedSales };
  }
}

function actualSpendToDate(spends: SpendRecord[], asOf: string): number {
  return spends
    .filter((spend) => spend.status === 'active')
    .filter((spend) => spend.businessDate === null || spend.businessDate <= asOf)
    .reduce((total, spend) => total + spend.amountCents, 0);
}

function actuals(
  summaries: readonly SummaryDailyDocument[],
  sales: SalesProjection[],
  month: string,
  asOf: string,
  salesSyncCompleted: boolean,
): FunnelActuals {
  const applicableSummaries = summaries.filter((summary) => summary.date.startsWith(month) && summary.date <= asOf && summary.normalized_metrics !== undefined);
  const applicableSales = sales.filter((sale) => {
    const bookedOn = phnomPenhBusinessDate(sale.bookingDate);
    return bookedOn !== null && bookedOn.startsWith(month) && bookedOn <= asOf;
  });
  const metrics = applicableSummaries.length === 0 ? null : applicableSummaries.reduce((total, summary) => ({
    messages: total.messages + summary.normalized_metrics!.messages,
    phoneLeads: total.phoneLeads + summary.normalized_metrics!.valid_phone_leads,
    visits: total.visits + summary.normalized_metrics!.completed_property_visits,
  }), { messages: 0, phoneLeads: 0, visits: 0 });
  if (applicableSales.length === 0) {
    return {
      messages: metrics?.messages ?? null,
      phoneLeads: metrics?.phoneLeads ?? null,
      visits: metrics?.visits ?? null,
      grossBookings: salesSyncCompleted ? 0 : null,
      cancellations: salesSyncCompleted ? 0 : null,
      netBookings: salesSyncCompleted ? 0 : null,
    };
  }
  const grossBookings = applicableSales.length;
  const cancellations = applicableSales.filter((sale) => {
    const cancelledOn = phnomPenhBusinessDate(sale.cancelledDate);
    return sale.status === 'CANCELLED' && cancelledOn !== null && cancelledOn <= asOf;
  }).length;
  return {
    messages: metrics?.messages ?? null, phoneLeads: metrics?.phoneLeads ?? null, visits: metrics?.visits ?? null,
    grossBookings, cancellations, netBookings: grossBookings - cancellations,
  };
}

function buildStages(
  forecast: FunnelForecast,
  expected: FunnelForecast,
  actual: FunnelActuals,
  spendCents: number,
  targets: Record<keyof FunnelForecast, number>,
  cancellationTarget: number,
): MonthlySummary['stages'] {
  const stage = (key: keyof FunnelForecast): StageSummary => {
    const actualValue = actual[key];
    const cost = actualValue === null ? null : costPerResultCents(spendCents, actualValue);
    return {
      forecast: forecast[key], expected: expected[key], actual: actualValue,
      variance: actualValue === null ? null : actualValue - expected[key],
      costPerResultCents: cost,
      targetCostPerResultCents: targets[key],
      outcomeStatus: key === 'cancellations'
        ? classifyCancellationRate(actual.cancellations === null || actual.grossBookings === null ? null : rate(actual.cancellations, actual.grossBookings), cancellationTarget)
        : classifyOutcome(actualValue, expected[key]),
      costStatus: classifyCostPerResult(cost, targets[key]),
    };
  };
  return { messages: stage('messages'), phoneLeads: stage('phoneLeads'), visits: stage('visits'), grossBookings: stage('grossBookings'), cancellations: stage('cancellations'), netBookings: stage('netBookings') };
}

function stageTargets(revision: ForecastRevision, forecast: FunnelForecast): Record<keyof FunnelForecast, number> {
  return {
    messages: revision.costPerMessageCents,
    phoneLeads: forecast.phoneLeads === 0 ? 0 : revision.monthlyBudgetCents / forecast.phoneLeads,
    visits: forecast.visits === 0 ? 0 : revision.monthlyBudgetCents / forecast.visits,
    grossBookings: forecast.grossBookings === 0 ? 0 : revision.monthlyBudgetCents / forecast.grossBookings,
    cancellations: forecast.cancellations === 0 ? 0 : revision.monthlyBudgetCents / forecast.cancellations,
    netBookings: forecast.netBookings === 0 ? 0 : revision.monthlyBudgetCents / forecast.netBookings,
  };
}

function activeDaysThrough(campaign: Campaign, month: string, asOf: string): number {
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  const start = maxDate(monthStart, campaign.startsOn);
  const end = minDate(monthEnd, asOf, campaign.endsOn ?? monthEnd);
  if (start > end) return 0;
  return Math.floor((dateAtStartOfDay(end).getTime() - dateAtStartOfDay(start).getTime()) / 86_400_000) + 1;
}

function isOpenMonth(month: string, asOf: string): boolean {
  return asOf < `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
}

function daysInMonth(month: string): number {
  validateMonth(month);
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

/** Converts a source instant to the only calendar used by Lead Control reporting. */
export { phnomPenhBusinessDate } from './business-time';

function selectedCancellationDate(sale: SalesProjection, view: CancellationView): string | null {
  return phnomPenhBusinessDate(view === 'cohort' ? sale.bookingDate : sale.cancelledDate);
}
function dateAtStartOfDay(value: string): Date { return new Date(`${value}T00:00:00.000Z`); }
function maxDate(...values: string[]): string { return values.reduce((max, value) => value > max ? value : max); }
function minDate(...values: string[]): string { return values.reduce((min, value) => value < min ? value : min); }
function compareRevision(left: ForecastRevision, right: ForecastRevision): number { return left.revisionNumber - right.revisionNumber || left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id); }

function validateMonth(value: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new RangeError('month must be YYYY-MM');
}

function validateBusinessDate(value: string, name: string): void {
  const date = dateAtStartOfDay(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new RangeError(`${name} must be YYYY-MM-DD`);
}
