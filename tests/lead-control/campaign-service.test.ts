import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditEvent,
  Campaign,
  CampaignInput,
  ForecastRevision,
  ForecastRevisionInput,
  SpendRecord,
} from '../../src/lead-control/models';
import { LeadControlRepository } from '../../src/lead-control/repository';
import { CampaignService } from '../../src/lead-control/service';

class InMemoryLeadControlRepository implements LeadControlRepository {
  campaigns: Campaign[] = [];
  revisions: ForecastRevision[] = [];
  spends: SpendRecord[] = [];
  events: AuditEvent[] = [];
  failNextAudit = false;
  private nextId = 1;
  private readonly lockTails = new Map<string, Promise<void>>();

  async createCampaign(input: Omit<Campaign, 'id'>): Promise<Campaign> {
    const campaign = { ...input, id: this.id() };
    this.campaigns.push(campaign);
    return campaign;
  }

  async updateCampaign(campaign: Campaign): Promise<void> {
    this.campaigns.splice(this.campaigns.findIndex((item) => item.id === campaign.id), 1, campaign);
  }

  async getCampaign(id: string): Promise<Campaign | null> {
    return this.campaigns.find((campaign) => campaign.id === id) ?? null;
  }

  async listCampaignsForPage(pageId: string): Promise<Campaign[]> {
    return this.campaigns.filter((campaign) => campaign.pageId === pageId);
  }

  async deleteCampaign(id: string): Promise<void> {
    this.campaigns = this.campaigns.filter((campaign) => campaign.id !== id);
  }

  async createRevision(input: Omit<ForecastRevision, 'id'>): Promise<ForecastRevision> {
    const revision = { ...input, id: this.id() };
    this.revisions.push(revision);
    return revision;
  }

  async updateRevision(revision: ForecastRevision): Promise<void> {
    this.revisions.splice(this.revisions.findIndex((item) => item.id === revision.id), 1, revision);
  }

  async getRevision(id: string): Promise<ForecastRevision | null> {
    return this.revisions.find((revision) => revision.id === id) ?? null;
  }

  async listRevisions(campaignId: string, month?: string): Promise<ForecastRevision[]> {
    return this.revisions.filter((revision) => revision.campaignId === campaignId && (month === undefined || revision.month === month));
  }

  async deleteRevision(id: string): Promise<void> {
    this.revisions = this.revisions.filter((revision) => revision.id !== id);
  }

  async createSpend(input: Omit<SpendRecord, 'id'>): Promise<SpendRecord> {
    const spend = { ...input, id: this.id() };
    this.spends.push(spend);
    return spend;
  }

  async updateSpend(spend: SpendRecord): Promise<void> {
    this.spends.splice(this.spends.findIndex((item) => item.id === spend.id), 1, spend);
  }

  async getSpend(id: string): Promise<SpendRecord | null> {
    return this.spends.find((spend) => spend.id === id) ?? null;
  }

  async listSpend(campaignId: string, month?: string): Promise<SpendRecord[]> {
    return this.spends.filter((spend) => spend.campaignId === campaignId && (month === undefined || spend.month === month));
  }

  async appendAuditEvent(event: Omit<AuditEvent, 'id'>): Promise<void> {
    if (this.failNextAudit) {
      this.failNextAudit = false;
      throw new Error('audit write failed');
    }
    this.events.push({ ...event, id: this.id() });
  }

  async runAtomic<T>(keys: readonly string[], operation: (repository: LeadControlRepository) => Promise<T>): Promise<T> {
    const release = await this.acquire([...new Set(keys)].sort());
    const snapshot = {
      campaigns: structuredClone(this.campaigns),
      revisions: structuredClone(this.revisions),
      spends: structuredClone(this.spends),
      events: structuredClone(this.events),
    };
    try {
      return await operation(this);
    } catch (error) {
      this.campaigns = snapshot.campaigns;
      this.revisions = snapshot.revisions;
      this.spends = snapshot.spends;
      this.events = snapshot.events;
      throw error;
    } finally {
      release();
    }
  }

  private async acquire(keys: string[]): Promise<() => void> {
    const releases: Array<() => void> = [];
    for (const key of keys) {
      const previous = this.lockTails.get(key) ?? Promise.resolve();
      let releaseCurrent!: () => void;
      const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
      this.lockTails.set(key, previous.then(() => current));
      await previous;
      releases.push(releaseCurrent);
    }
    return () => releases.reverse().forEach((release) => release());
  }

  private id(): string {
    return String(this.nextId++);
  }
}

const campaignInput: CampaignInput = {
  name: 'September leads',
  pageId: 'page-a',
  startsOn: '2026-09-01',
  endsOn: '2026-09-30',
};

const forecastInput: ForecastRevisionInput = {
  month: '2026-09',
  monthlyBudgetCents: 100_000,
  costPerMessageCents: 150,
  messageToPhoneRate: 0.5,
  phoneToVisitRate: 0.5,
  visitToBookingRate: 0.5,
  cancellationRate: 0.2,
};

function buildService(repo = new InMemoryLeadControlRepository()): { service: CampaignService; repo: InMemoryLeadControlRepository } {
  return { service: new CampaignService(repo, () => new Date('2026-09-01T00:00:00.000Z')), repo };
}

test('validates campaign names, business dates, and date order', async () => {
  const { service } = buildService();

  await assert.rejects(service.createCampaign({ ...campaignInput, name: '  ' }, 'manager'), /name/);
  await assert.rejects(service.createCampaign({ ...campaignInput, startsOn: '09/01/2026' }, 'manager'), /startsOn/);
  await assert.rejects(service.createCampaign({ ...campaignInput, startsOn: '2026-02-30' }, 'manager'), /startsOn/);
  await assert.rejects(service.createCampaign({ ...campaignInput, startsOn: '2026-10-01', endsOn: '2026-09-30' }, 'manager'), /endsOn/);
});

test('rejects same-page date overlap including a shared boundary and open-ended range', async () => {
  const { service } = buildService();

  const first = await service.createCampaign(campaignInput, 'manager');
  await service.activateCampaign(first.id, 'manager');
  const boundary = await service.createCampaign({ ...campaignInput, name: 'Boundary', startsOn: '2026-09-30', endsOn: '2026-10-15' }, 'manager');
  await assert.rejects(
    service.activateCampaign(boundary.id, 'manager'),
    /overlap/,
  );
  const openEnded = await service.createCampaign({ ...campaignInput, name: 'Open ended', startsOn: '2026-09-15', endsOn: null }, 'manager');
  await assert.rejects(
    service.activateCampaign(openEnded.id, 'manager'),
    /overlap/,
  );
  const otherPage = await service.createCampaign({ ...campaignInput, name: 'Other page', pageId: 'page-b', startsOn: '2026-09-15', endsOn: null }, 'manager');
  await service.activateCampaign(otherPage.id, 'manager');
});

test('deletes an unprotected draft campaign and records its audit event', async () => {
  const { service, repo } = buildService();
  const campaign = await service.createCampaign(campaignInput, 'manager');

  assert.equal(campaign.status, 'draft');
  await service.deleteCampaign(campaign.id, 'manager');

  assert.equal(repo.campaigns.length, 0);
  assert.deepEqual(repo.events.map((event) => event.action), ['campaign.created', 'campaign.deleted']);
});

test('rejects hard deletion for active and archived campaigns even without protected history', async () => {
  const { service } = buildService();
  const active = await service.createCampaign(campaignInput, 'manager');
  await service.activateCampaign(active.id, 'manager');
  await assert.rejects(service.deleteCampaign(active.id, 'manager'), /draft/);
  await service.archiveCampaign(active.id, 'manager');
  await assert.rejects(service.deleteCampaign(active.id, 'manager'), /draft/);
});

test('deletes a draft forecast but preserves an approved baseline', async () => {
  const { service, repo } = buildService();
  const campaign = await service.createCampaign(campaignInput, 'manager');
  await service.activateCampaign(campaign.id, 'manager');
  const draft = await service.createForecastDraft(campaign.id, forecastInput, 'manager');

  await service.deleteForecastDraft(draft.id, 'manager');
  assert.equal(repo.revisions.length, 0);

  const baseline = await service.createForecastDraft(campaign.id, forecastInput, 'manager');
  await service.approveForecast(baseline.id, 'manager');
  await assert.rejects(service.deleteForecastDraft(baseline.id, 'manager'), /approved/);
});

test('only archives campaigns once an approved forecast or actual spend exists', async () => {
  const { service, repo } = buildService();
  const campaign = await service.createCampaign(campaignInput, 'manager');
  const draft = await service.createForecastDraft(campaign.id, forecastInput, 'manager');
  await service.approveForecast(draft.id, 'manager');

  await assert.rejects(service.deleteCampaign(campaign.id, 'manager'), /archived/);
  await service.archiveCampaign(campaign.id, 'manager');

  assert.equal(repo.campaigns[0].status, 'archived');
  assert.equal(repo.events.at(-1)?.action, 'campaign.archived');

  const spendOnly = await service.createCampaign({ ...campaignInput, name: 'Spend only', pageId: 'page-b' }, 'manager');
  await service.recordSpend({ campaignId: spendOnly.id, month: '2026-09', businessDate: null, amountCents: 100_000 }, 'manager');
  await assert.rejects(service.deleteCampaign(spendOnly.id, 'manager'), /archived/);
});

test('approves an immutable baseline and creates a later editable revision', async () => {
  const { service, repo } = buildService();
  const campaign = await service.createCampaign(campaignInput, 'manager');
  const baseline = await service.createForecastDraft(campaign.id, forecastInput, 'manager');

  const approved = await service.approveForecast(baseline.id, 'manager');
  assert.deepEqual(repo.events.at(-1), {
    id: repo.events.at(-1)?.id,
    action: 'forecast.approved',
    actor: 'manager',
    entityType: 'forecast_revision',
    entityId: baseline.id,
    occurredAt: new Date('2026-09-01T00:00:00.000Z'),
    details: { campaignId: campaign.id, month: '2026-09' },
  });
  await assert.rejects(service.updateForecastDraft(approved.id, { ...forecastInput, monthlyBudgetCents: 120_000 }, 'manager'), /immutable/);

  const revision = await service.createForecastRevision(approved.id, { ...forecastInput, monthlyBudgetCents: 120_000 }, 'manager');
  assert.equal(revision.kind, 'revision');
  assert.equal(revision.revisionNumber, 2);
  assert.equal(revision.status, 'draft');
  assert.equal(repo.events.at(-1)?.action, 'forecast.revision_created');
  assert.equal(repo.events.at(-1)?.details.sourceRevisionId, approved.id);
});

test('keeps daily and monthly spend exclusive per campaign-month', async () => {
  const { service, repo } = buildService();
  const campaign = await service.createCampaign(campaignInput, 'manager');

  const daily = await service.recordSpend({ campaignId: campaign.id, month: '2026-09', businessDate: '2026-09-01', amountCents: 10_000 }, 'manager');
  assert.equal(repo.events.at(-1)?.action, 'spend.recorded');
  assert.deepEqual(repo.events.at(-1)?.details, { campaignId: campaign.id, month: '2026-09', mode: 'daily' });
  await assert.rejects(
    service.recordSpend({ campaignId: campaign.id, month: '2026-09', businessDate: null, amountCents: 100_000 }, 'manager'),
    /daily.*monthly/i,
  );
  const updated = await service.updateSpend(daily.id, { ...daily, amountCents: 12_000 }, 'manager');
  assert.equal(updated.amountCents, 12_000);
  assert.equal(repo.events.at(-1)?.action, 'spend.updated');
  await assert.rejects(service.updateSpend(daily.id, { ...daily, businessDate: null }, 'manager'), /mode/);
});

test('serializes concurrent activation and spend-mode writes so one conflict wins', async () => {
  const { service, repo } = buildService();
  const first = await service.createCampaign(campaignInput, 'manager');
  const second = await service.createCampaign({ ...campaignInput, name: 'Competing' }, 'manager');
  const activation = await Promise.allSettled([
    service.activateCampaign(first.id, 'manager'),
    service.activateCampaign(second.id, 'manager'),
  ]);
  assert.equal(activation.filter((result) => result.status === 'fulfilled').length, 1);

  const active = repo.campaigns.find((campaign) => campaign.status === 'active');
  assert.ok(active);
  const spend = await Promise.allSettled([
    service.recordSpend({ campaignId: active.id, month: '2026-09', businessDate: '2026-09-01', amountCents: 10_000 }, 'manager'),
    service.recordSpend({ campaignId: active.id, month: '2026-09', businessDate: null, amountCents: 100_000 }, 'manager'),
  ]);
  assert.equal(spend.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(repo.spends.filter((item) => item.status === 'active').length, 1);
});

test('serializes draft deletion with first spend creation so no orphan spend can persist', async () => {
  const { service, repo } = buildService();
  const campaign = await service.createCampaign(campaignInput, 'manager');

  const results = await Promise.allSettled([
    service.deleteCampaign(campaign.id, 'manager'),
    service.recordSpend({ campaignId: campaign.id, month: '2026-09', businessDate: null, amountCents: 100_000 }, 'manager'),
  ]);

  const campaignStillExists = repo.campaigns.some((item) => item.id === campaign.id);
  const spendExists = repo.spends.some((item) => item.campaignId === campaign.id);
  assert.equal(campaignStillExists, spendExists);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
});

test('rolls back a state mutation when its audit event cannot be persisted', async () => {
  const { service, repo } = buildService();
  const campaign = await service.createCampaign(campaignInput, 'manager');
  const draft = await service.createForecastDraft(campaign.id, forecastInput, 'manager');
  repo.failNextAudit = true;

  await assert.rejects(service.approveForecast(draft.id, 'manager'), /audit write failed/);

  assert.equal(repo.revisions.find((revision) => revision.id === draft.id)?.status, 'draft');
  assert.equal(repo.events.some((event) => event.action === 'forecast.approved'), false);
});

test('archives prior mode records only after a confirmed spend-mode switch and preserves audit history', async () => {
  const { service, repo } = buildService();
  const campaign = await service.createCampaign(campaignInput, 'manager');
  await service.recordSpend({ campaignId: campaign.id, month: '2026-09', businessDate: null, amountCents: 100_000 }, 'manager');

  await assert.rejects(service.switchSpendMode(campaign.id, '2026-09', 'daily', false, 'manager'), /confirm/i);
  await service.switchSpendMode(campaign.id, '2026-09', 'daily', true, 'manager');
  const daily = await service.recordSpend({ campaignId: campaign.id, month: '2026-09', businessDate: '2026-09-01', amountCents: 10_000 }, 'manager');

  assert.equal(repo.spends.find((spend) => spend.businessDate === null)?.status, 'archived');
  assert.equal(daily.status, 'active');
  assert.equal(repo.events.at(-2)?.action, 'spend.mode_switched');
  assert.equal(repo.events.at(-2)?.actor, 'manager');
});
