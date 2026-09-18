import express from 'express';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { createLeadControlRouter } from '../../src/api/lead-control-routes';
import { AuditEvent, Campaign, ForecastRevision, SpendRecord } from '../../src/lead-control/models';
import { LeadControlRepository } from '../../src/lead-control/repository';
import { CampaignService } from '../../src/lead-control/service';
import { SummaryService } from '../../src/lead-control/summary-service';
import { SalesProjection } from '../../src/lead-control/sync-service';

class InMemoryLeadControlRepository implements LeadControlRepository {
  campaigns: Campaign[] = [];
  revisions: ForecastRevision[] = [];
  spends: SpendRecord[] = [];
  events: AuditEvent[] = [];
  private nextId = 1;

  async createCampaign(input: Omit<Campaign, 'id'>): Promise<Campaign> { const value = { ...input, id: `campaign-${this.nextId++}` }; this.campaigns.push(value); return value; }
  async updateCampaign(value: Campaign): Promise<void> { this.campaigns.splice(this.campaigns.findIndex((item) => item.id === value.id), 1, value); }
  async getCampaign(id: string): Promise<Campaign | null> { return this.campaigns.find((item) => item.id === id) ?? null; }
  async listCampaignsForPage(pageId: string): Promise<Campaign[]> { return this.campaigns.filter((item) => item.pageId === pageId); }
  async deleteCampaign(id: string): Promise<void> { this.campaigns = this.campaigns.filter((item) => item.id !== id); }
  async createRevision(input: Omit<ForecastRevision, 'id'>): Promise<ForecastRevision> { const value = { ...input, id: `forecast-${this.nextId++}` }; this.revisions.push(value); return value; }
  async updateRevision(value: ForecastRevision): Promise<void> { this.revisions.splice(this.revisions.findIndex((item) => item.id === value.id), 1, value); }
  async getRevision(id: string): Promise<ForecastRevision | null> { return this.revisions.find((item) => item.id === id) ?? null; }
  async listRevisions(campaignId: string, month?: string): Promise<ForecastRevision[]> { return this.revisions.filter((item) => item.campaignId === campaignId && (month === undefined || item.month === month)); }
  async deleteRevision(id: string): Promise<void> { this.revisions = this.revisions.filter((item) => item.id !== id); }
  async createSpend(input: Omit<SpendRecord, 'id'>): Promise<SpendRecord> { const value = { ...input, id: `spend-${this.nextId++}` }; this.spends.push(value); return value; }
  async updateSpend(value: SpendRecord): Promise<void> { this.spends.splice(this.spends.findIndex((item) => item.id === value.id), 1, value); }
  async getSpend(id: string): Promise<SpendRecord | null> { return this.spends.find((item) => item.id === id) ?? null; }
  async listSpend(campaignId: string, month?: string): Promise<SpendRecord[]> { return this.spends.filter((item) => item.campaignId === campaignId && (month === undefined || item.month === month)); }
  async appendAuditEvent(input: Omit<AuditEvent, 'id'>): Promise<void> { this.events.push({ ...input, id: `event-${this.nextId++}` }); }
  async runAtomic<T>(_keys: readonly string[], operation: (repository: LeadControlRepository) => Promise<T>): Promise<T> { return operation(this); }
}

/** Isolated HTTP fixture: guided mutations run through the authorized production router and service. */
export async function startUiFixture() {
  const app = express(); app.use(express.json());
  const now = new Date();
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit' }).format(now);
  const repository = new InMemoryLeadControlRepository();
  const campaign: Campaign = { id: 'c1', name: 'North · ផ្ទះ', pageId: 'north', propertyProject: 'North Residences', objective: 'Property visits', audience: 'Phnom Penh buyers', spendMode: 'daily', startsOn: `${month}-01`, endsOn: null, status: 'active', createdAt: now, createdBy: 'manager', archivedAt: null, archivedBy: null };
  const revision: ForecastRevision = { id: 'f1', campaignId: campaign.id, month, monthlyBudgetCents: 120000, costPerMessageCents: 100, messageToPhoneRate: .3, phoneToVisitRate: .5, visitToBookingRate: .2, cancellationRate: .1, kind: 'baseline', revisionNumber: 1, status: 'approved', createdAt: now, createdBy: 'manager', approvedAt: now, approvedBy: 'manager' };
  const sale: SalesProjection = { saleId: 'sale-unmatched', status: 'BOOKED', normalizedPhone: '85512345678', bookingDate: now, completedDate: null, cancelledDate: null, updatedAt: now, campaignId: null, attributedLeadId: null, attributionKind: 'unmatched', attributedAt: null };
  const cancellation: SalesProjection = { ...sale, saleId: 'sale-event', status: 'CANCELLED', cancelledDate: now, campaignId: campaign.id, attributionKind: 'automatic' };
  repository.campaigns.push(campaign); repository.revisions.push(revision);
  let unmatched = [sale];
  const summaryService = new SummaryService({
    getCampaign: (id) => repository.getCampaign(id),
    listRevisions: (id, selectedMonth) => repository.listRevisions(id, selectedMonth),
    listSpend: (id, selectedMonth) => repository.listSpend(id, selectedMonth),
    listDailySummaries: async () => [{ date: `${month}-01`, normalized_metrics: { messages: 520, valid_phone_leads: 132, completed_property_visits: 58 } }],
    listSalesProjections: async (id) => id === campaign.id ? [cancellation] : [],
    listUnmatchedSales: async () => unmatched,
    getSalesSyncCursor: async () => ({ updatedAt: now, saleId: 'sale-1' }),
    countMalformedSales: async () => 0,
  });
  const service = new CampaignService(repository, () => now);
  app.use('/lead-control', createLeadControlRouter({ writesEnabled: true, repository, service, summaryService, salesService: { manuallyAttribute: async () => { unmatched = []; } } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, repository, month,
    screenshot: (name: string) => path.resolve(`.superpowers/sdd/2026-09-17-lead-control/task-7-${name}.png`),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
