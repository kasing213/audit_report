import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express, { Express } from 'express';
import { parseBulkReport } from '../../src/parser/bulk-report-parser';
import { createDataEntryRouter } from '../../src/api/data-entry-routes';
import { Campaign } from '../../src/lead-control/models';
import { resolveActiveCampaignForPageAndDate } from '../../src/lead-control/service';
import { LeadControlRepository, pageIdCompatibilityPattern } from '../../src/lead-control/repository';

test('bulk parser keeps raw report counters while proposing separate normalized funnel metrics', () => {
  const rawReport = [
    'Date 17/09/26',
    'Page River Homes',
    'Messages = 14',
    'Valid phone leads = 4',
    'Completed property visits = 2',
    'Tel1 = 012 345 678',
  ].join('\n');

  const parsed = parseBulkReport(rawReport);
  const summary = parsed.summary as typeof parsed.summary & { normalized_metrics?: unknown };

  assert.deepEqual(parsed.summary.counters, {
    messages: 14,
    valid_phone_leads: 4,
    completed_property_visits: 2,
  });
  assert.equal(parsed.summary.raw_text, rawReport);
  assert.deepEqual(summary.normalized_metrics, {
    messages: 14,
    valid_phone_leads: 4,
    completed_property_visits: 2,
  });
});

async function request(app: Express, body: unknown): Promise<{ status: number; body: any }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const response = await fetch(`http://127.0.0.1:${address.port}/data-entry/api/bulk/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const activeCampaign: Campaign = {
  id: 'campaign-river',
  name: 'River Homes September',
  pageId: 'river homes',
  startsOn: '2026-09-01',
  endsOn: '2026-09-30',
  status: 'active',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  createdBy: 'developer',
  archivedAt: null,
  archivedBy: null,
};

test('campaign resolution normalizes the page and uses active inclusive business-date ranges', async () => {
  const repository = {
    listCampaignsForPage: async (pageId: string) => pageId === 'river homes' ? [activeCampaign] : [],
  } as unknown as LeadControlRepository;

  assert.equal((await resolveActiveCampaignForPageAndDate(repository, '🚩 Page River Homes', '2026-09-01'))?.id, 'campaign-river');
  assert.equal((await resolveActiveCampaignForPageAndDate(repository, 'Page River Homes', '2026-09-30'))?.id, 'campaign-river');
  assert.equal(await resolveActiveCampaignForPageAndDate(repository, 'Page River Homes', '2026-10-01'), null);
  assert.equal(await resolveActiveCampaignForPageAndDate(repository, null, '2026-09-17'), null);
});

test('legacy campaign page identifiers remain compatible with normalized report pages', () => {
  const pattern = pageIdCompatibilityPattern('river homes');
  assert.match('River Homes', pattern);
  assert.match('  🚩 Page RIVER   HOMES  ', pattern);
  assert.match('ផេក River Homes', pattern);
  assert.doesNotMatch('Other River Homes', pattern);
});

test('campaign resolution rejects multiple active page matches for one business date', async () => {
  const repository = {
    listCampaignsForPage: async () => [activeCampaign, { ...activeCampaign, id: 'campaign-overlap' }],
  } as unknown as LeadControlRepository;

  await assert.rejects(
    resolveActiveCampaignForPageAndDate(repository, 'Page River Homes', '2026-09-17'),
    /ambiguous active campaigns for page and business date/,
  );
});

function summaryPayload() {
  return {
    counters: { messages: 14, valid_phone_leads: 4, completed_property_visits: 2, other: 99 },
    raw_text: 'Messages = 14\nValid phone leads = 4\nCompleted property visits = 2\nOther = 99',
    normalized_metrics: { messages: 17, valid_phone_leads: 5, completed_property_visits: 3 },
  };
}

test('bulk confirmation saves edited normalized metrics alongside untouched raw report data and campaign attribution', async () => {
  const saved: any[] = [];
  const app = express();
  app.use('/data-entry', createDataEntryRouter({
    repository: {
      saveLeadEvents: async () => [],
      saveDailySummary: async (summary: unknown) => { saved.push(summary); return 'summary-1'; },
      saveChangeLog: async () => undefined,
      logAudit: async () => undefined,
    },
    resolveCampaign: async () => activeCampaign,
  }));

  const response = await request(app, {
    header: { date: '2026-09-17', follower: 'Sok', page: '🚩 Page River Homes' },
    drafts: [],
    summary: summaryPayload(),
  });

  assert.deepEqual(response, {
    status: 200,
    body: { success: true, imported: 0, skipped: 0, summary_id: 'summary-1', event_ids: [] },
  });
  assert.deepEqual(saved, [{
    date: '2026-09-17',
    follower: 'Sok',
    page: '🚩 Page River Homes',
    counters: { messages: 14, valid_phone_leads: 4, completed_property_visits: 2, other: 99 },
    raw_text: 'Messages = 14\nValid phone leads = 4\nCompleted property visits = 2\nOther = 99',
    normalized_metrics: { messages: 17, valid_phone_leads: 5, completed_property_visits: 3 },
    campaign_id: 'campaign-river',
    source: { model: 'bulk-paste' },
    created_at: saved[0].created_at,
  }]);
});

test('bulk confirmation saves unassigned normalized metrics when no campaign matches', async () => {
  const saved: any[] = [];
  const app = express();
  app.use('/data-entry', createDataEntryRouter({
    repository: {
      saveLeadEvents: async () => [],
      saveDailySummary: async (summary: unknown) => { saved.push(summary); return 'summary-2'; },
      saveChangeLog: async () => undefined,
      logAudit: async () => undefined,
    },
    resolveCampaign: async () => null,
  }));

  const response = await request(app, {
    header: { date: '2026-09-17', follower: null, page: 'Page without a campaign' },
    drafts: [],
    summary: summaryPayload(),
  });

  assert.equal(response.status, 200);
  assert.equal(saved[0].campaign_id, null);
  assert.deepEqual(saved[0].normalized_metrics, { messages: 17, valid_phone_leads: 5, completed_property_visits: 3 });
});

test('bulk confirmation freezes the active campaign onto each lead event for later sales attribution', async () => {
  const savedEvents: any[] = [];
  const app = express();
  app.use('/data-entry', createDataEntryRouter({
    repository: {
      saveLeadEvents: async (events: unknown[]) => { savedEvents.push(...events); return ['lead-1']; },
      saveDailySummary: async () => 'unexpected',
      saveChangeLog: async () => undefined,
      logAudit: async () => undefined,
    },
    resolveCampaign: async () => activeCampaign,
  }));

  const response = await request(app, {
    header: { date: '2026-09-17', follower: 'Sok', page: 'Page River Homes' },
    drafts: [{ customer_phone: '012 345 678', customer_name: 'Sok', slot: '1' }],
  });

  assert.equal(response.status, 200);
  assert.equal(savedEvents[0].campaign_id, 'campaign-river');
  assert.equal(savedEvents[0].customer.phone, '012 345 678');
  assert.equal(savedEvents[0].normalized_phone, '+85512345678');
});

test('bulk confirmation rejects ambiguous active campaign resolution before persisting', async () => {
  let saves = 0;
  const app = express();
  app.use('/data-entry', createDataEntryRouter({
    repository: {
      saveLeadEvents: async () => [],
      saveDailySummary: async () => { saves++; return 'unexpected'; },
      saveChangeLog: async () => undefined,
      logAudit: async () => undefined,
    },
    resolveCampaign: async () => { throw new Error('ambiguous active campaigns for page and business date'); },
  }));

  const response = await request(app, {
    header: { date: '2026-09-17', follower: null, page: 'Page River Homes' },
    drafts: [],
    summary: summaryPayload(),
  });

  assert.deepEqual(response, {
    status: 409,
    body: { error: 'ambiguous active campaigns for page and business date' },
  });
  assert.equal(saves, 0);
});

test('bulk confirmation rejects invalid normalized metrics as validation errors', async () => {
  let saves = 0;
  const app = express();
  app.use('/data-entry', createDataEntryRouter({
    repository: {
      saveLeadEvents: async () => [],
      saveDailySummary: async () => { saves++; return 'unexpected'; },
      saveChangeLog: async () => undefined,
      logAudit: async () => undefined,
    },
    resolveCampaign: async () => activeCampaign,
  }));

  const response = await request(app, {
    header: { date: '2026-09-17', follower: null, page: 'Page River Homes' },
    drafts: [],
    summary: {
      ...summaryPayload(),
      normalized_metrics: { messages: -1, valid_phone_leads: 5, completed_property_visits: 3 },
    },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /normalized_metrics\.messages/);
  assert.equal(saves, 0);
});
