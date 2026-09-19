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
import { SummaryDataRepository, SummaryService } from '../../src/lead-control/summary-service';
import { createLeadControlRouter } from '../../src/api/lead-control-routes';
import { ApiServer } from '../../src/api/server';
import { createSessionCookie } from '../../src/api/auth-middleware';

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

function fixture(): { app: Express; repository: InMemoryLeadControlRepository; service: CampaignService } {
  const repository = new InMemoryLeadControlRepository();
  const service = new CampaignService(repository, () => new Date('2026-09-01T00:00:00.000Z'));
  const app = express();
  app.use(express.json());
  app.use('/lead-control', createLeadControlRouter({ service, repository, writesEnabled: true }));
  return { app, repository, service };
}

async function request(app: Express, method: string, path: string, body?: unknown, token = ACTOR_TOKEN): Promise<{ status: number; body: any }> {
  return requestWithHeaders(app, method, path, body, { Authorization: `Bearer ${token}` });
}

async function requestWithHeaders(
  app: Express,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function malformedJsonRequest(app: Express, path: string): Promise<{ status: number; body: any }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACTOR_TOKEN}`, 'Content-Type': 'application/json' },
      body: '{not json',
    });
    return { status: response.status, body: await response.json() };
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
  assert.equal((await request(app, 'DELETE', `/lead-control/forecasts/${revised.body.forecast.id}`)).status, 204);
  assert.equal(repository.events.at(-1)?.actor, 'developer');
});

test('guided campaign and forecast command returns the atomically activated approved final state', async () => {
  const { app, repository } = fixture();

  const response = await request(app, 'POST', '/lead-control/workflows/campaign-forecast', {
    campaign,
    forecast,
    approve: true,
    activate: true,
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.campaign.status, 'active');
  assert.equal(response.body.forecast.status, 'approved');
  assert.equal(repository.campaigns.length, 1);
  assert.equal(repository.revisions.length, 1);
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

test('spend read routes return populated, empty, and missing results', async () => {
  const { app } = fixture();
  const campaignId = (await request(app, 'POST', '/lead-control/campaigns', campaign)).body.campaign.id;
  const created = await request(app, 'POST', '/lead-control/spend', { campaignId, month: '2026-09', businessDate: null, amountCents: 100_000 });

  assert.deepEqual(await request(app, 'GET', `/lead-control/spend/${created.body.spend.id}`), {
    status: 200,
    body: { spend: created.body.spend },
  });
  assert.deepEqual(await request(app, 'GET', `/lead-control/spend?campaignId=${campaignId}&month=2026-09`), {
    status: 200,
    body: { spends: [created.body.spend] },
  });
  assert.deepEqual(await request(app, 'GET', `/lead-control/spend?campaignId=${campaignId}&month=2026-10`), {
    status: 200,
    body: { spends: [] },
  });
  assert.deepEqual(await request(app, 'GET', '/lead-control/spend/missing'), {
    status: 404,
    body: { error: 'spend record not found' },
  });
  assert.deepEqual(await request(app, 'GET', '/lead-control/spend?month=2026-09'), {
    status: 400,
    body: { error: 'campaignId query parameter is required' },
  });
});

test('calculator routes calculate results from budget and budget from a net-booking target', async () => {
  const { app } = fixture();
  const fromBudget = await request(app, 'POST', '/lead-control/calculator/budget-to-results', { budgetCents: 10_000, ...forecast });
  assert.equal(fromBudget.status, 200);
  assert.equal(fromBudget.body.forecast.messages, 10000 / 150);
  const toBudget = await request(app, 'POST', '/lead-control/calculator/target-to-budget', { targetNetBookings: 10, ...forecast });
  assert.deepEqual(toBudget.body, { budgetCents: 15_000 });
});

test('summary routes expose the injected monthly, cancellation, reconciliation, and sync-health queries', async () => {
  const { app } = fixture();
  const summaryCampaign: Campaign = { id: 'summary-campaign', name: 'Summary', pageId: 'page-a', startsOn: '2026-09-01', endsOn: null, status: 'active', createdAt: new Date(), createdBy: 'developer', archivedAt: null, archivedBy: null };
  const summaryRepository: SummaryDataRepository = {
    getCampaign: async (id) => id === summaryCampaign.id ? summaryCampaign : null,
    listRevisions: async () => [{ id: 'summary-revision', campaignId: summaryCampaign.id, ...forecast, revisionNumber: 1, kind: 'baseline', status: 'approved', createdAt: new Date(), createdBy: 'developer', approvedAt: new Date(), approvedBy: 'developer' }],
    listSpend: async () => [], listDailySummaries: async () => [], listSalesProjections: async () => [], listUnmatchedSales: async () => [], getSalesSyncCursor: async () => null, countMalformedSales: async () => 0,
  };
  app.use('/summary-test', createLeadControlRouter({ summaryService: new SummaryService(summaryRepository) }));

  const summary = await request(app, 'GET', '/summary-test/campaigns/summary-campaign/summary?month=2026-09&asOf=2026-09-20');
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.summary.campaign.id, 'summary-campaign');
  assert.deepEqual((await request(app, 'GET', '/summary-test/campaigns/summary-campaign/cancellations?month=2026-09&view=cohort')).body.cancellations, []);
  assert.deepEqual((await request(app, 'GET', '/summary-test/reconciliation/unmatched')).body.sales, []);
  assert.equal((await request(app, 'GET', '/summary-test/sync/health')).body.health.status, 'Pending');
});

test('manual attribution is routed through the injected atomic sales service with the authenticated actor', async () => {
  const { app } = fixture();
  const calls: Array<{ saleId: string; campaignId: string; actor: string }> = [];
  app.use('/attribution-test', createLeadControlRouter({ writesEnabled: true, salesService: { manuallyAttribute: async (saleId, campaignId, actor) => { calls.push({ saleId, campaignId, actor }); } } }));

  assert.equal((await request(app, 'POST', '/attribution-test/sales/sale-7/attribution', { campaignId: 'campaign-7' })).status, 204);
  assert.deepEqual(calls, [{ saleId: 'sale-7', campaignId: 'campaign-7', actor: 'developer' }]);
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

test('campaign activation and active campaign updates report overlap conflicts as 409', async () => {
  const { app, service } = fixture();
  const first = await request(app, 'POST', '/lead-control/campaigns', campaign);
  await service.activateCampaign(first.body.campaign.id, 'developer');
  const second = await request(app, 'POST', '/lead-control/campaigns', { ...campaign, name: 'October leads', startsOn: '2026-10-01', endsOn: '2026-10-31' });
  await service.activateCampaign(second.body.campaign.id, 'developer');
  const overlapping = await request(app, 'POST', '/lead-control/campaigns', { ...campaign, name: 'Overlap', startsOn: '2026-09-15', endsOn: '2026-09-20' });

  assert.deepEqual(await request(app, 'POST', `/lead-control/campaigns/${overlapping.body.campaign.id}/activate`), {
    status: 409,
    body: { error: 'campaign dates overlap an active campaign for this page' },
  });
  assert.deepEqual(await request(app, 'PUT', `/lead-control/campaigns/${second.body.campaign.id}`, { ...campaign, name: 'October leads', startsOn: '2026-09-15', endsOn: '2026-10-31' }), {
    status: 409,
    body: { error: 'campaign dates overlap an active campaign for this page' },
  });
});

test('the production mount authorizes a manager, denies an agent, and reports malformed JSON as 400', async () => {
  const app = new ApiServer().getApp() as unknown as Express;
  const managerCookie = `audit_session=${encodeURIComponent(createSessionCookie('manager'))}`;

  assert.equal((await requestWithHeaders(app, 'GET', '/lead-control/campaigns', undefined, { Cookie: managerCookie })).status, 400);
  assert.equal((await requestWithHeaders(app, 'GET', '/lead-control/campaigns?pageId=page-a', undefined, { Authorization: `Bearer ${AGENT_TOKEN}` })).status, 403);
  assert.deepEqual(await malformedJsonRequest(app, '/lead-control/campaigns'), {
    status: 400,
    body: { error: 'Invalid JSON' },
  });
});

// Production mutation caught: ApiServer forgets to pass the runtime write setting to its Lead Control mount.
test('ApiServer passes the configured Lead Control write gate into the production router', async () => {
  const managerCookie = `audit_session=${encodeURIComponent(createSessionCookie('manager'))}`;
  const readOnly = new ApiServer(3001, { leadControlWritesEnabled: false }).getApp() as unknown as Express;
  const writable = new ApiServer(3001, { leadControlWritesEnabled: true }).getApp() as unknown as Express;

  assert.deepEqual(
    await requestWithHeaders(readOnly, 'POST', '/lead-control/not-a-route', {}, { Cookie: managerCookie }),
    { status: 403, body: { error: 'Lead Control is in read-only comparison mode' } },
  );
  assert.deepEqual(
    await requestWithHeaders(writable, 'POST', '/lead-control/not-a-route', {}, { Cookie: managerCookie }),
    { status: 404, body: { error: 'Not found', path: '/lead-control/not-a-route' } },
  );
});

// Production mutation caught: ApiServer configures Lead Control read-only but leaves bulk normalization writable.
test('ApiServer passes the default Lead Control write gate into the production bulk-entry router', async () => {
  const managerCookie = `audit_session=${encodeURIComponent(createSessionCookie('manager'))}`;
  const savedEvents: any[] = [];
  const savedSummaries: any[] = [];
  let resolutions = 0;
  const app = new ApiServer(3001, {
    leadControlWritesEnabled: false,
    dataEntryRouteDependencies: {
      repository: {
        saveLeadEvents: async (events: unknown[]) => { savedEvents.push(...events); return ['raw-lead']; },
        saveDailySummary: async (summary: unknown) => { savedSummaries.push(summary); return 'raw-summary'; },
        saveChangeLog: async () => undefined,
        logAudit: async () => undefined,
      },
      resolveCampaign: async () => { resolutions++; return null; },
    },
  } as any).getApp() as unknown as Express;

  const response = await requestWithHeaders(app, 'POST', '/data-entry/api/bulk/confirm', {
    header: { date: '2026-09-17', follower: 'Sok', page: 'Page River Homes' },
    drafts: [{ customer_phone: '012 345 678', slot: '1' }],
    summary: {
      counters: { messages: 14 },
      raw_text: 'Messages = 14',
      normalized_metrics: { messages: 14, valid_phone_leads: 4, completed_property_visits: 2 },
    },
  }, { Cookie: managerCookie });

  assert.equal(response.status, 200);
  assert.equal(resolutions, 0);
  assert.equal(savedEvents[0].normalized_phone, undefined);
  assert.equal(savedEvents[0].campaign_id, undefined);
  assert.equal(savedSummaries[0].normalized_metrics, undefined);
  assert.equal(savedSummaries[0].campaign_id, undefined);
});

// Production mutation caught: any persistence route bypasses the default read-only gate or invokes its service.
test('read-only gate blocks every Lead Control mutation family before service mutation', async () => {
  const repository = new InMemoryLeadControlRepository();
  const service = new CampaignService(repository, () => new Date('2026-09-01T00:00:00.000Z'));
  const attributionCalls: string[] = [];
  const app = express();
  app.use(express.json());
  app.use('/lead-control', createLeadControlRouter({
    repository,
    service,
    writesEnabled: false,
    salesService: { manuallyAttribute: async (saleId) => { attributionCalls.push(saleId); } },
  }));
  const expected = { status: 403, body: { error: 'Lead Control is in read-only comparison mode' } };
  const mutations: Array<[string, string]> = [
    ['POST', '/lead-control/campaigns'],
    ['PUT', '/lead-control/campaigns/c1'],
    ['POST', '/lead-control/campaigns/c1/archive'],
    ['POST', '/lead-control/campaigns/c1/activate'],
    ['DELETE', '/lead-control/campaigns/c1'],
    ['POST', '/lead-control/campaigns/c1/forecasts'],
    ['PUT', '/lead-control/forecasts/f1'],
    ['POST', '/lead-control/forecasts/f1/approve'],
    ['POST', '/lead-control/forecasts/f1/revisions'],
    ['DELETE', '/lead-control/forecasts/f1'],
    ['POST', '/lead-control/workflows/campaign-forecast'],
    ['POST', '/lead-control/spend/mode-switch'],
    ['POST', '/lead-control/spend'],
    ['PUT', '/lead-control/spend/s1'],
    ['DELETE', '/lead-control/spend/s1'],
    ['POST', '/lead-control/sales/sale-1/attribution'],
  ];

  for (const [method, path] of mutations) {
    assert.deepEqual(await request(app, method, path, {}), expected, `${method} ${path}`);
  }
  assert.deepEqual(repository.campaigns, []);
  assert.deepEqual(repository.revisions, []);
  assert.deepEqual(repository.spends, []);
  assert.deepEqual(repository.events, []);
  assert.deepEqual(attributionCalls, []);
});

// Production mutation caught: the gate blocks comparison calculators or read-only HTTP methods.
test('read-only gate keeps GET, HEAD, and only the two calculator POSTs available', async () => {
  const app = express();
  app.use(express.json());
  app.use('/lead-control', createLeadControlRouter({ repository: new InMemoryLeadControlRepository(), writesEnabled: false }));
  const calculatorInput = { budgetCents: 10_000, targetNetBookings: 10, ...forecast };

  assert.equal((await request(app, 'GET', '/lead-control/campaigns?pageId=page-a')).status, 200);
  assert.equal((await request(app, 'HEAD', '/lead-control/campaigns?pageId=page-a')).status, 200);
  assert.equal((await request(app, 'POST', '/lead-control/calculator/budget-to-results', calculatorInput)).status, 200);
  assert.equal((await request(app, 'POST', '/lead-control/calculator/target-to-budget', calculatorInput)).status, 200);
  assert.deepEqual(await request(app, 'POST', '/lead-control/calculator/not-approved', calculatorInput), {
    status: 403,
    body: { error: 'Lead Control is in read-only comparison mode' },
  });
});
