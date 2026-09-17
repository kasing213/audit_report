import {
  AuditEvent,
  Campaign,
  CampaignInput,
  ForecastRevision,
  ForecastRevisionInput,
  SpendInput,
  SpendMode,
  SpendRecord,
} from './models';
import { LeadControlRepository } from './repository';

export class CampaignService {
  constructor(
    private readonly repository: LeadControlRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createCampaign(input: CampaignInput, actor: string): Promise<Campaign> {
    validateCampaign(input);
    await this.assertNoActivePageOverlap(input.pageId, input.startsOn, input.endsOn);
    const occurredAt = this.now();
    const campaign = await this.repository.createCampaign({
      ...input,
      name: input.name.trim(),
      pageId: input.pageId.trim(),
      status: 'active',
      createdAt: occurredAt,
      createdBy: actor,
      archivedAt: null,
      archivedBy: null,
    });
    await this.audit('campaign.created', actor, 'campaign', campaign.id, { pageId: campaign.pageId });
    return campaign;
  }

  async updateCampaign(id: string, input: CampaignInput, actor: string): Promise<Campaign> {
    validateCampaign(input);
    const existing = await this.requireCampaign(id);
    if (existing.status !== 'active') throw new Error('archived campaigns cannot be edited');
    await this.assertNoActivePageOverlap(input.pageId, input.startsOn, input.endsOn, id);
    const campaign: Campaign = { ...existing, ...input, name: input.name.trim(), pageId: input.pageId.trim() };
    await this.repository.updateCampaign(campaign);
    await this.audit('campaign.updated', actor, 'campaign', id, { pageId: campaign.pageId });
    return campaign;
  }

  async deleteCampaign(id: string, actor: string): Promise<void> {
    await this.requireCampaign(id);
    const protectedHistory = await this.hasProtectedHistory(id);
    if (protectedHistory) throw new Error('campaign has protected history and must be archived');
    await this.repository.deleteCampaign(id);
    await this.audit('campaign.deleted', actor, 'campaign', id, {});
  }

  async archiveCampaign(id: string, actor: string): Promise<Campaign> {
    const existing = await this.requireCampaign(id);
    if (existing.status === 'archived') return existing;
    const campaign: Campaign = { ...existing, status: 'archived', archivedAt: this.now(), archivedBy: actor };
    await this.repository.updateCampaign(campaign);
    await this.audit('campaign.archived', actor, 'campaign', id, {});
    return campaign;
  }

  async createForecastDraft(campaignId: string, input: ForecastRevisionInput, actor: string): Promise<ForecastRevision> {
    await this.requireCampaign(campaignId);
    validateForecast(input);
    const revisions = await this.repository.listRevisions(campaignId, input.month);
    if (revisions.some((revision) => revision.kind === 'baseline')) throw new Error('baseline already exists; create a revision');
    const revision = await this.repository.createRevision({
      ...input,
      campaignId,
      revisionNumber: 1,
      kind: 'baseline',
      status: 'draft',
      createdAt: this.now(),
      createdBy: actor,
      approvedAt: null,
      approvedBy: null,
    });
    await this.audit('forecast.draft_created', actor, 'forecast_revision', revision.id, { campaignId, month: input.month });
    return revision;
  }

  async updateForecastDraft(id: string, input: ForecastRevisionInput, actor: string): Promise<ForecastRevision> {
    validateForecast(input);
    const existing = await this.requireRevision(id);
    if (existing.status === 'approved') throw new Error('approved forecasts are immutable');
    if (existing.month !== input.month) throw new Error('forecast month cannot be changed');
    const revision: ForecastRevision = { ...existing, ...input };
    await this.repository.updateRevision(revision);
    await this.audit('forecast.draft_updated', actor, 'forecast_revision', id, { campaignId: revision.campaignId, month: revision.month });
    return revision;
  }

  async deleteForecastDraft(id: string, actor: string): Promise<void> {
    const existing = await this.requireRevision(id);
    if (existing.status === 'approved') throw new Error('approved forecasts cannot be deleted');
    await this.repository.deleteRevision(id);
    await this.audit('forecast.draft_deleted', actor, 'forecast_revision', id, { campaignId: existing.campaignId, month: existing.month });
  }

  async approveForecast(id: string, actor: string): Promise<ForecastRevision> {
    const existing = await this.requireRevision(id);
    if (existing.status === 'approved') return existing;
    const revision: ForecastRevision = { ...existing, status: 'approved', approvedAt: this.now(), approvedBy: actor };
    await this.repository.updateRevision(revision);
    await this.audit('forecast.approved', actor, 'forecast_revision', id, { campaignId: revision.campaignId, month: revision.month });
    return revision;
  }

  async createForecastRevision(
    approvedRevisionId: string,
    input: ForecastRevisionInput,
    actor: string,
  ): Promise<ForecastRevision> {
    validateForecast(input);
    const approved = await this.requireRevision(approvedRevisionId);
    if (approved.status !== 'approved') throw new Error('forecast must be approved before a revision can be created');
    if (approved.month !== input.month) throw new Error('forecast revision month must match baseline');
    const revisions = await this.repository.listRevisions(approved.campaignId, input.month);
    const revision = await this.repository.createRevision({
      ...input,
      campaignId: approved.campaignId,
      revisionNumber: Math.max(...revisions.map((item) => item.revisionNumber)) + 1,
      kind: 'revision',
      status: 'draft',
      createdAt: this.now(),
      createdBy: actor,
      approvedAt: null,
      approvedBy: null,
    });
    await this.audit('forecast.revision_created', actor, 'forecast_revision', revision.id, {
      campaignId: approved.campaignId,
      month: input.month,
      sourceRevisionId: approvedRevisionId,
    });
    return revision;
  }

  async recordSpend(input: SpendInput, actor: string): Promise<SpendRecord> {
    await this.requireCampaign(input.campaignId);
    validateSpend(input);
    const mode: SpendMode = input.businessDate === null ? 'monthly' : 'daily';
    const existing = await this.repository.listSpend(input.campaignId, input.month);
    const active = existing.filter((spend) => spend.status === 'active');
    if (active.some((spend) => spend.mode !== mode)) {
      throw new Error('daily and monthly spend records are mutually exclusive');
    }
    if (active.some((spend) => spend.businessDate === input.businessDate)) {
      throw new Error('an active spend record already exists for this campaign-month date');
    }
    const spend = await this.repository.createSpend({
      ...input,
      mode,
      status: 'active',
      createdAt: this.now(),
      createdBy: actor,
      archivedAt: null,
      archivedBy: null,
    });
    await this.audit('spend.recorded', actor, 'spend', spend.id, { campaignId: input.campaignId, month: input.month, mode });
    return spend;
  }

  async switchSpendMode(
    campaignId: string,
    month: string,
    targetMode: SpendMode,
    confirmed: boolean,
    actor: string,
  ): Promise<void> {
    await this.requireCampaign(campaignId);
    validateMonth(month);
    const active = (await this.repository.listSpend(campaignId, month)).filter((spend) => spend.status === 'active');
    if (active.length === 0 || active.every((spend) => spend.mode === targetMode)) return;
    if (!confirmed) throw new Error('confirm spend mode switch before replacing records');
    const archivedAt = this.now();
    for (const spend of active) {
      await this.repository.updateSpend({ ...spend, status: 'archived', archivedAt, archivedBy: actor });
    }
    await this.audit('spend.mode_switched', actor, 'spend', active[0].id, { campaignId, month, targetMode });
  }

  private async requireCampaign(id: string): Promise<Campaign> {
    const campaign = await this.repository.getCampaign(id);
    if (!campaign) throw new Error('campaign not found');
    return campaign;
  }

  private async requireRevision(id: string): Promise<ForecastRevision> {
    const revision = await this.repository.getRevision(id);
    if (!revision) throw new Error('forecast revision not found');
    return revision;
  }

  private async assertNoActivePageOverlap(
    pageId: string,
    startsOn: string,
    endsOn: string | null,
    excludingId?: string,
  ): Promise<void> {
    const campaigns = await this.repository.listCampaignsForPage(pageId.trim());
    const overlaps = campaigns.some((campaign) =>
      campaign.id !== excludingId && campaign.status === 'active' && datesOverlap(startsOn, endsOn, campaign.startsOn, campaign.endsOn),
    );
    if (overlaps) throw new Error('campaign dates overlap an active campaign for this page');
  }

  private async hasProtectedHistory(campaignId: string): Promise<boolean> {
    const revisions = await this.repository.listRevisions(campaignId);
    if (revisions.some((revision) => revision.status === 'approved')) return true;
    const spend = await this.repository.listSpend(campaignId);
    return spend.length > 0;
  }

  private async audit(
    action: AuditEvent['action'],
    actor: string,
    entityType: AuditEvent['entityType'],
    entityId: string,
    details: AuditEvent['details'],
  ): Promise<void> {
    await this.repository.appendAuditEvent({ action, actor, entityType, entityId, details, occurredAt: this.now() });
  }
}

function validateCampaign(input: CampaignInput): void {
  if (input.name.trim().length === 0) throw new RangeError('name is required');
  if (input.pageId.trim().length === 0) throw new RangeError('pageId is required');
  validateBusinessDate(input.startsOn, 'startsOn');
  if (input.endsOn !== null) {
    validateBusinessDate(input.endsOn, 'endsOn');
    if (input.endsOn < input.startsOn) throw new RangeError('endsOn cannot be before startsOn');
  }
}

function validateForecast(input: ForecastRevisionInput): void {
  validateMonth(input.month);
  validateNonNegativeCents(input.monthlyBudgetCents, 'monthlyBudgetCents');
  validatePositiveCents(input.costPerMessageCents, 'costPerMessageCents');
  validateRate(input.messageToPhoneRate, 'messageToPhoneRate');
  validateRate(input.phoneToVisitRate, 'phoneToVisitRate');
  validateRate(input.visitToBookingRate, 'visitToBookingRate');
  validateRate(input.cancellationRate, 'cancellationRate');
}

function validateSpend(input: SpendInput): void {
  validateMonth(input.month);
  if (input.businessDate !== null) {
    validateBusinessDate(input.businessDate, 'businessDate');
    if (!input.businessDate.startsWith(`${input.month}-`)) throw new RangeError('businessDate must be in month');
  }
  validateNonNegativeCents(input.amountCents, 'amountCents');
}

function validateMonth(value: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new RangeError('month must be YYYY-MM');
}

function validateBusinessDate(value: string, name: string): void {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${name} must be YYYY-MM-DD`);
  }
}

function validateNonNegativeCents(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
}

function validatePositiveCents(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

function validateRate(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be between 0 and 1`);
}

function datesOverlap(firstStart: string, firstEnd: string | null, secondStart: string, secondEnd: string | null): boolean {
  return (firstEnd === null || secondStart <= firstEnd) && (secondEnd === null || firstStart <= secondEnd);
}
