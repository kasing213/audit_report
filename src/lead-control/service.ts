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
    return this.repository.runAtomic([pageKey(input.pageId)], async (repository) => {
      const occurredAt = this.now();
      const campaign = await repository.createCampaign({
        ...input,
        name: input.name.trim(),
        pageId: input.pageId.trim(),
        status: 'draft',
        createdAt: occurredAt,
        createdBy: actor,
        archivedAt: null,
        archivedBy: null,
      });
      await this.audit(repository, 'campaign.created', actor, 'campaign', campaign.id, { pageId: campaign.pageId, status: campaign.status });
      return campaign;
    });
  }

  async updateCampaign(id: string, input: CampaignInput, actor: string): Promise<Campaign> {
    validateCampaign(input);
    const original = await this.requireCampaign(id);
    return this.repository.runAtomic([pageKey(original.pageId), pageKey(input.pageId)], async (repository) => {
    const existing = await this.requireCampaign(id, repository);
    if (existing.status === 'archived') throw new Error('archived campaigns cannot be edited');
    if (existing.status === 'active') await this.assertNoActivePageOverlap(input.pageId, input.startsOn, input.endsOn, id, repository);
    const campaign: Campaign = { ...existing, ...input, name: input.name.trim(), pageId: input.pageId.trim() };
    await repository.updateCampaign(campaign);
    await this.audit(repository, 'campaign.updated', actor, 'campaign', id, { pageId: campaign.pageId });
    return campaign;
    });
  }

  async activateCampaign(id: string, actor: string): Promise<Campaign> {
    const before = await this.requireCampaign(id);
    return this.repository.runAtomic([pageKey(before.pageId)], async (repository) => {
      const existing = await this.requireCampaign(id, repository);
      if (existing.status !== 'draft') throw new Error('only draft campaigns can be activated');
      await this.assertNoActivePageOverlap(existing.pageId, existing.startsOn, existing.endsOn, id, repository);
      const campaign: Campaign = { ...existing, status: 'active' };
      await repository.updateCampaign(campaign);
      await this.audit(repository, 'campaign.activated', actor, 'campaign', id, { pageId: campaign.pageId });
      return campaign;
    });
  }

  async deleteCampaign(id: string, actor: string): Promise<void> {
    await this.repository.runAtomic([`campaign:${id}`], async (repository) => {
      const campaign = await this.requireCampaign(id, repository);
      if (campaign.status !== 'draft') throw new Error('only draft campaigns can be deleted');
      const protectedHistory = await this.hasProtectedHistory(id, repository);
      if (protectedHistory) throw new Error('campaign has protected history and must be archived');
      await repository.deleteCampaign(id);
      await this.audit(repository, 'campaign.deleted', actor, 'campaign', id, {});
    });
  }

  async archiveCampaign(id: string, actor: string): Promise<Campaign> {
    return this.repository.runAtomic([`campaign:${id}`], async (repository) => {
      const existing = await this.requireCampaign(id, repository);
      if (existing.status === 'archived') return existing;
      const campaign: Campaign = { ...existing, status: 'archived', archivedAt: this.now(), archivedBy: actor };
      await repository.updateCampaign(campaign);
      await this.audit(repository, 'campaign.archived', actor, 'campaign', id, {});
      return campaign;
    });
  }

  async createForecastDraft(campaignId: string, input: ForecastRevisionInput, actor: string): Promise<ForecastRevision> {
    validateForecast(input);
    return this.repository.runAtomic([`campaign:${campaignId}`], async (repository) => {
    await this.requireCampaign(campaignId, repository);
    const revisions = await repository.listRevisions(campaignId, input.month);
    if (revisions.some((revision) => revision.kind === 'baseline')) throw new Error('baseline already exists; create a revision');
    const revision = await repository.createRevision({
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
    await this.audit(repository, 'forecast.draft_created', actor, 'forecast_revision', revision.id, { campaignId, month: input.month });
    return revision;
    });
  }

  async updateForecastDraft(id: string, input: ForecastRevisionInput, actor: string): Promise<ForecastRevision> {
    validateForecast(input);
    const before = await this.requireRevision(id);
    return this.repository.runAtomic([`campaign:${before.campaignId}`], async (repository) => {
      const existing = await this.requireRevision(id, repository);
      if (existing.status === 'approved') throw new Error('approved forecasts are immutable');
      if (existing.month !== input.month) throw new Error('forecast month cannot be changed');
      const revision: ForecastRevision = { ...existing, ...input };
      await repository.updateRevision(revision);
      await this.audit(repository, 'forecast.draft_updated', actor, 'forecast_revision', id, { campaignId: revision.campaignId, month: revision.month });
      return revision;
    });
  }

  async deleteForecastDraft(id: string, actor: string): Promise<void> {
    const before = await this.requireRevision(id);
    await this.repository.runAtomic([`campaign:${before.campaignId}`], async (repository) => {
      const existing = await this.requireRevision(id, repository);
      if (existing.status === 'approved') throw new Error('approved forecasts cannot be deleted');
      await repository.deleteRevision(id);
      await this.audit(repository, 'forecast.draft_deleted', actor, 'forecast_revision', id, { campaignId: existing.campaignId, month: existing.month });
    });
  }

  async approveForecast(id: string, actor: string): Promise<ForecastRevision> {
    const before = await this.requireRevision(id);
    return this.repository.runAtomic([`campaign:${before.campaignId}`], async (repository) => {
      const existing = await this.requireRevision(id, repository);
      if (existing.status === 'approved') return existing;
      const revision: ForecastRevision = { ...existing, status: 'approved', approvedAt: this.now(), approvedBy: actor };
      await repository.updateRevision(revision);
      await this.audit(repository, 'forecast.approved', actor, 'forecast_revision', id, { campaignId: revision.campaignId, month: revision.month });
      return revision;
    });
  }

  async createForecastRevision(
    approvedRevisionId: string,
    input: ForecastRevisionInput,
    actor: string,
  ): Promise<ForecastRevision> {
    validateForecast(input);
    const before = await this.requireRevision(approvedRevisionId);
    return this.repository.runAtomic([`campaign:${before.campaignId}`], async (repository) => {
    const approved = await this.requireRevision(approvedRevisionId, repository);
    if (approved.status !== 'approved') throw new Error('forecast must be approved before a revision can be created');
    if (approved.month !== input.month) throw new Error('forecast revision month must match baseline');
    const revisions = await repository.listRevisions(approved.campaignId, input.month);
    const revision = await repository.createRevision({
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
    await this.audit(repository, 'forecast.revision_created', actor, 'forecast_revision', revision.id, {
      campaignId: approved.campaignId,
      month: input.month,
      sourceRevisionId: approvedRevisionId,
    });
    return revision;
    });
  }

  async recordSpend(input: SpendInput, actor: string): Promise<SpendRecord> {
    validateSpend(input);
    const mode: SpendMode = input.businessDate === null ? 'monthly' : 'daily';
    return this.repository.runAtomic([`campaign:${input.campaignId}`, spendKey(input.campaignId, input.month)], async (repository) => {
    await this.requireCampaign(input.campaignId, repository);
    const existing = await repository.listSpend(input.campaignId, input.month);
    const active = existing.filter((spend) => spend.status === 'active');
    if (active.some((spend) => spend.mode !== mode)) {
      throw new Error('daily and monthly spend records are mutually exclusive');
    }
    if (active.some((spend) => spend.businessDate === input.businessDate)) {
      throw new Error('an active spend record already exists for this campaign-month date');
    }
    const spend = await repository.createSpend({
      ...input,
      mode,
      status: 'active',
      createdAt: this.now(),
      createdBy: actor,
      archivedAt: null,
      archivedBy: null,
    });
    await this.audit(repository, 'spend.recorded', actor, 'spend', spend.id, { campaignId: input.campaignId, month: input.month, mode });
    return spend;
    });
  }

  async updateSpend(id: string, input: SpendInput, actor: string): Promise<SpendRecord> {
    validateSpend(input);
    const before = await this.requireSpend(id);
    return this.repository.runAtomic([spendKey(before.campaignId, before.month)], async (repository) => {
      const existing = await this.requireSpend(id, repository);
      const mode: SpendMode = input.businessDate === null ? 'monthly' : 'daily';
      if (input.campaignId !== existing.campaignId || input.month !== existing.month || mode !== existing.mode) {
        throw new Error('spend campaign, month, and mode cannot be changed');
      }
      const spend: SpendRecord = { ...existing, ...input, mode };
      await repository.updateSpend(spend);
      await this.audit(repository, 'spend.updated', actor, 'spend', id, {
        campaignId: spend.campaignId,
        month: spend.month,
        mode: spend.mode,
      });
      return spend;
    });
  }

  /** Soft-delete preserves the immutable spend and audit history for reporting. */
  async deleteSpend(id: string, actor: string): Promise<void> {
    const before = await this.requireSpend(id);
    await this.repository.runAtomic([spendKey(before.campaignId, before.month)], async (repository) => {
      const existing = await this.requireSpend(id, repository);
      if (existing.status === 'archived') return;
      const archivedAt = this.now();
      await repository.updateSpend({ ...existing, status: 'archived', archivedAt, archivedBy: actor });
      await this.audit(repository, 'spend.deleted', actor, 'spend', id, {
        campaignId: existing.campaignId,
        month: existing.month,
        mode: existing.mode,
      });
    });
  }

  async getSpend(id: string): Promise<SpendRecord> {
    return this.requireSpend(id);
  }

  async listSpend(campaignId: string, month: string): Promise<SpendRecord[]> {
    validateMonth(month);
    return this.repository.listSpend(campaignId, month);
  }

  async switchSpendMode(
    campaignId: string,
    month: string,
    targetMode: SpendMode,
    confirmed: boolean,
    actor: string,
  ): Promise<void> {
    validateMonth(month);
    await this.repository.runAtomic([spendKey(campaignId, month)], async (repository) => {
      await this.requireCampaign(campaignId, repository);
      const active = (await repository.listSpend(campaignId, month)).filter((spend) => spend.status === 'active');
      if (active.length === 0 || active.every((spend) => spend.mode === targetMode)) return;
      if (!confirmed) throw new Error('confirm spend mode switch before replacing records');
      const archivedAt = this.now();
      for (const spend of active) {
        await repository.updateSpend({ ...spend, status: 'archived', archivedAt, archivedBy: actor });
      }
      await this.audit(repository, 'spend.mode_switched', actor, 'spend', active[0].id, { campaignId, month, targetMode });
    });
  }

  private async requireCampaign(id: string, repository = this.repository): Promise<Campaign> {
    const campaign = await repository.getCampaign(id);
    if (!campaign) throw new Error('campaign not found');
    return campaign;
  }

  private async requireRevision(id: string, repository = this.repository): Promise<ForecastRevision> {
    const revision = await repository.getRevision(id);
    if (!revision) throw new Error('forecast revision not found');
    return revision;
  }

  private async requireSpend(id: string, repository = this.repository): Promise<SpendRecord> {
    const spend = await repository.getSpend(id);
    if (!spend) throw new Error('spend record not found');
    return spend;
  }

  private async assertNoActivePageOverlap(
    pageId: string,
    startsOn: string,
    endsOn: string | null,
    excludingId?: string,
    repository = this.repository,
  ): Promise<void> {
    const campaigns = await repository.listCampaignsForPage(pageId.trim());
    const overlaps = campaigns.some((campaign) =>
      campaign.id !== excludingId && campaign.status === 'active' && datesOverlap(startsOn, endsOn, campaign.startsOn, campaign.endsOn),
    );
    if (overlaps) throw new Error('campaign dates overlap an active campaign for this page');
  }

  private async hasProtectedHistory(campaignId: string, repository = this.repository): Promise<boolean> {
    const revisions = await repository.listRevisions(campaignId);
    if (revisions.some((revision) => revision.status === 'approved')) return true;
    const spend = await repository.listSpend(campaignId);
    return spend.length > 0;
  }

  private async audit(
    repository: LeadControlRepository,
    action: AuditEvent['action'],
    actor: string,
    entityType: AuditEvent['entityType'],
    entityId: string,
    details: AuditEvent['details'],
  ): Promise<void> {
    await repository.appendAuditEvent({ action, actor, entityType, entityId, details, occurredAt: this.now() });
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

function pageKey(pageId: string): string {
  return `page:${pageId.trim()}`;
}

function spendKey(campaignId: string, month: string): string {
  return `spend:${campaignId}:${month}`;
}
