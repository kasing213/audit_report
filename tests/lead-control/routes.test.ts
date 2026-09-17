import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express, { Express } from 'express';
import {
  AuditEvent,
  Campaign,
  ForecastRevision,
  SpendRecord,
} from '../../src/lead-control/models';
import { LeadControlRepository } from '../../src/lead-control/repository';
import { CampaignService } from '../../src/lead-control/service';
import { createLeadControlRouter } from '../../src/api/lead-control-routes';

const ACTOR_TOKEN = 'lead-control-developer-token';
const AGENT_TOKEN = 'lead-control-agent-token';
process.env.DASHBOARD_TOKEN = ACTOR_TOKEN;
process.env.AGENT_TOKEN = AGENT_TOKEN;

class InMemoryLeadControlRepository implements LeadControlRepository {
  campaigns: Campaign[] = [];
  revisions: ForecastRevision[] = [];
  spends: SpendRecord[] = [];
  events: AuditEvent[] = [];
  private nextId = 1;

  async createCampaign(input: Omit<Campaign, 'id'>): Promise<Campaign> { const value = { ...input, id: this.id() }; this.campaigns.push(value); return value; }
  async updateCampaign(value: Campaign): Promise<void> { this.campaigns.splice(this.campaigns.findIndex((item) => item.id === value.id), 1, value); }
  async getCampaign(id: string): Promise<Campaign | null> { return this.campaigns.find((item) => item.id === id) ?? null; }
  async listCampaignsForPage(pageId: string): Promise<Campaign[]> { return this.campaigns.filter((item) => item.pageId === pageId); }
  async deleteCampaign(id: string): Promise<void> { this.campaigns = this.campaigns.filter((item) => item.id !== id); }
  async createRevision(input: Omit<ForecastRevision, 'id'>): Promise<ForecastRevision> { const value = { ...input, id: this.id() }; this.revisions.push(value); return value; }
  async updateRevision(value: ForecastRevision): Promise<void> { this.revisions.splice(this.revisions.findIndex((item) => item.id === value.id), 1, value); }
  async getRevision(id: string): Promise<ForecastRevision | null> { return this.revisions.find((item) => item.id === id) ?? null; }
  async listRevisions(campaignId: string, month?: string): Promise<ForecastRevision[]> { return this.revisions.filter((item) => item.campaignId === campaignId && (month === undefined || item.month === month)); }
  async deleteRevision(id: string): Promise<void> { this.revisions = this.revisions.filter((item) => item.id !== id); }
  async createSpend(input: Omit<SpendRecord, 'id'>): Promise<SpendRecord> { const value = { ...input, id: this.id() }; this.spends.push(value); return value; }
  async updateSpend(value: SpendRecord): Promise<void> { this.spends.splice(this.spends.findIndex((item) => item.id === value.id), 1, value); }
  async getSpend(id: string): Promise<SpendRecord | null> { return this.spends.find((item) => item.id === id) ?? null; }
  async listSpend(campaignId: string, month?: string): Promise<SpendRecord[]> { return this.spends.filter((item) => item.campaignId === campaignId && (month === undefined || item.month === month)); }
  async appendAuditEvent(input: Omit<AuditEvent, 'id'>): Promise<void> { this.events.push({ ...input, id: this.id() }); }
  async runAtomic<T>(_keys: readonly string[], operation: (repository: LeadControlRepository) => Promise<T>): Promise<T> { return operation(this); }
  private id(): string { return String(this.nextId++); }
}

function fixture(): { app: Express; repository: InMemoryLeadControlRepository } {
  const repository = new InMemoryLeadControlRepository();
  const service = new CampaignService(repository, () => new Date('2026-09-01T00:00:00.000Z'));
  const app = express();
  app.use(express.json());
  app.use('/lead-control', createLeadControlRouter({ service, repository }));
  return { app, repository };
}

async function request(app: Express, method: string, path: string, body?: unknown, token = ACTOR_TOKEN): Promise<{ status: number; body: any }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const campaign = { name: 'September leads', pageId: 'page-a', startsOn: '2026-09-01', endsOn: '2026-09-30' };
const forecast = {
  month: '2026-09', monthlyBudgetCents: 100_000, costPerMessageCents: 150,
  messageToPhoneRate: 0.5, phoneToVisitRate: 0.5, visitToBookingRate: 0.5, cancellationRate: 0.2,
};

test('campaign routes create, list, read, edit, archive, and delete campaigns with the authenticated actor', async () => {
  const { app, repository } = fixture();
  const created = await request(app, 'POST', '/lead-control/campaigns', campaign);
  assert.equal(created.status, 201);
  assert.equal(created.body.campaign.createdBy, 'developer');
  const id = created.body.campaign.id;
  assert.deepEqual((await request(app, 'GET', '/lead-control/campaigns?pageId=page-a')).body.campaigns.map((item: Campaign) => item.id), [id]);
  assert.equal((await request(app, 'GET', `/lead-control/campaigns/${id}`)).body.campaign.name, 'September leads');
  assert.equal((await request(app, 'PUT', `/lead-control/campaigns/${id}`, { ...campaign, name: 'Updated leads' })).body.campaign.name, 'Updated leads');
  assert.equal((await request(app, 'POST', `/lead-control/campaigns/${id}/archive`)).body.campaign.archivedBy, 'developer');
  assert.equal((await request(app, 'DELETE', `/lead-control/campaigns/${id}`)).status, 409);
  const deletable = await request(app, 'POST', '/lead-control/campaigns', { ...campaign, pageId: 'page-b' });
  assert.equal((await request(app, 'DELETE', `/lead-control/campaigns/${deletable.body.campaign.id}`)).status, 204);
  assert.equal(repository.events.every((event) => event.actor === 'developer'), true);
});

test('forecast routes draft, update, approve, and revise forecasts', async () => {
  const { app, repository } = fixture();
  const campaignId = (await request(app, 'POST', '/lead-control/campaigns', campaign)).body.campaign.id;
  const drafted = await request(app, 'POST', `/lead-control/campaigns/${campaignId}/forecasts`, forecast);
  assert.equal(drafted.status, 201);
  const updated = await request(app, 'PUT', `/lead-control/forecasts/${drafted.body.forecast.id}`, { ...forecast, monthlyBudgetCents: 120_000 });
  assert.equal(updated.body.forecast.monthlyBudgetCents, 120_000);
  const approved = await request(app, 'POST', `/lead-control/forecasts/${drafted.body.forecast.id}/approve`);
  assert.equal(approved.body.forecast.status, 'approved');
  const revised = await request(app, 'POST', `/lead-control/forecasts/${drafted.body.forecast.id}/revisions`, { ...forecast, monthlyBudgetCents: 140_000 });
  assert.equal(revised.body.forecast.revisionNumber, 2);
  assert.equal(repository.events.at(-1)?.actor, 'developer');
});

test('actual spend routes create, update, delete, and require confirmation before switching mode', async () => {
  const { app } = fixture();
  const campaignId = (await request(app, 'POST', '/lead-control/campaigns', campaign)).body.campaign.id;
  const spend = await request(app, 'POST', '/lead-control/spend', { campaignId, month: '2026-09', businessDate: null, amountCents: 100_000 });
  assert.equal(spend.status, 201);
  assert.equal((await request(app, 'PUT', `/lead-control/spend/${spend.body.spend.id}`, { campaignId, month: '2026-09', businessDate: null, amountCents: 120_000 })).body.spend.amountCents, 120_000);
  assert.equal((await request(app, 'POST', `/lead-control/spend/mode-switch`, { campaignId, month: '2026-09', targetMode: 'daily', confirmed: false })).status, 409);
  assert.equal((await request(app, 'POST', `/lead-control/spend/mode-switch`, { campaignId, month: '2026-09', targetMode: 'daily', confirmed: true })).status, 204);
  const daily = await request(app, 'POST', '/lead-control/spend', { campaignId, month: '2026-09', businessDate: '2026-09-01', amountCents: 10_000 });
  assert.equal((await request(app, 'DELETE', `/lead-control/spend/${daily.body.spend.id}`)).status, 204);
});

test('calculator routes calculate results from budget and budget from a net-booking target', async () => {
  const { app } = fixture();
  const fromBudget = await request(app, 'POST', '/lead-control/calculator/budget-to-results', { budgetCents: 10_000, ...forecast });
  assert.equal(fromBudget.status, 200);
  assert.equal(fromBudget.body.forecast.messages, 10000 / 150);
  const toBudget = await request(app, 'POST', '/lead-control/calculator/target-to-budget', { targetNetBookings: 10, ...forecast });
  assert.deepEqual(toBudget.body, { budgetCents: 15_000 });
});

test('routes return stable validation, missing, conflict, and forbidden responses', async () => {
  const { app } = fixture();
  assert.deepEqual(await request(app, 'POST', '/lead-control/campaigns', { ...campaign, name: '' }), { status: 400, body: { error: 'name is required' } });
  assert.deepEqual(await request(app, 'GET', '/lead-control/campaigns/missing'), { status: 404, body: { error: 'campaign not found' } });
  const first = await request(app, 'POST', '/lead-control/campaigns', campaign);
  await request(app, 'POST', `/lead-control/campaigns/${first.body.campaign.id}/forecasts`, forecast);
  assert.deepEqual(await request(app, 'POST', `/lead-control/campaigns/${first.body.campaign.id}/forecasts`, forecast), { status: 409, body: { error: 'baseline already exists; create a revision' } });
  assert.deepEqual(await request(app, 'GET', '/lead-control/campaigns?pageId=page-a', undefined, AGENT_TOKEN), { status: 403, body: { error: 'lead control role required' } });
});
