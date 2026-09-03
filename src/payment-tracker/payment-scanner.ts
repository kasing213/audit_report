/**
 * The daily Payment Tracker scan: read due receivables, group them, and draft
 * one reminder per (phone, exact local due date).
 *
 * Two ordering rules carry the safety story:
 *
 *  1. Approved wording is checked BEFORE anything else. A scan that could not
 *     produce a message must not read the source or write a draft.
 *  2. The complete source read is validated and grouped BEFORE the first
 *     proposal write. A truncated read or a mid-scan outage therefore creates
 *     nothing at all, rather than reminding half a group and silently dropping
 *     the rest — which would leave the remainder permanently suppressed by the
 *     dedupe boundary of the drafts that did get written.
 *
 * Individual bad receivables and mixed-currency groups are counted and skipped;
 * they never block an unrelated valid group.
 */
import { Logger } from '../utils/logger';
import { OutreachRepository, ProposalCollectionPort } from '../outreach/outreach-repository';
import { PaymentTemplateDocument, isPaymentTemplateActive } from './payment-template-repository';
import { PaymentTemplateError, renderPaymentTemplate } from './payment-template';
import { mapPaymentProposal } from './payment-proposal-mapper';
import { RawPaymentAr, ValidatedPaymentAr } from './payment-types';
import {
  cambodiaDateKey,
  endOfTomorrowCambodia,
  groupPaymentArs,
  validatePaymentAr,
} from './payment-domain';

/** Redacted scan summary. Counts and timestamps only — never customer data. */
export interface PaymentScanResult {
  scanned_at: Date;
  cutoff_date: string;
  source_records: number;
  eligible_records: number;
  invalid_records: number;
  groups: number;
  blocked_groups: number;
  created: number;
  duplicate_boundaries: number;
  auto_approved: boolean;
}

/** Mutable health record. The scheduler owns persisting it. */
export interface PaymentScanHealthPort {
  last_error_code: string | null;
  summaries: PaymentScanResult[];
}

export interface PaymentScannerDependencies {
  source: { findCandidates(cutoff: Date): Promise<RawPaymentAr[]> };
  proposals: ProposalCollectionPort;
  health: PaymentScanHealthPort;
  /** Loaded fresh per run by the scheduler, so wording edits take effect next scan. */
  template: PaymentTemplateDocument | null;
  workerState: { auto_approve: boolean };
}

export class PaymentTrackerScanner {
  private readonly repo: OutreachRepository;

  constructor(private readonly deps: PaymentScannerDependencies) {
    this.repo = new OutreachRepository(deps.proposals);
  }

  async run(now: Date): Promise<PaymentScanResult> {
    if (!isPaymentTemplateActive(this.deps.template)) {
      this.deps.health.last_error_code = 'template_not_approved';
      throw new Error('approved payment wording required before scanning');
    }
    const templateText = (this.deps.template as PaymentTemplateDocument).template_text;

    const cutoff = endOfTomorrowCambodia(now);

    let rows: RawPaymentAr[];
    try {
      rows = await this.deps.source.findCandidates(cutoff);
    } catch (err) {
      // Fail the whole scan closed. Record a machine-readable code for the UI,
      // never the driver message, which can carry the connection string.
      this.deps.health.last_error_code = 'source_unavailable';
      Logger.error('payment tracker source read failed', err as Error);
      throw err;
    }

    const eligible: ValidatedPaymentAr[] = [];
    let invalidRecords = 0;
    for (const row of rows) {
      const validated = validatePaymentAr(row, cutoff);
      if (validated.ok) eligible.push(validated.ar);
      else invalidRecords++;
    }

    const { groups, errors } = groupPaymentArs(eligible);
    let blockedGroups = errors.length;

    const autoApprove = this.deps.workerState.auto_approve === true;
    let created = 0;
    let duplicateBoundaries = 0;

    for (const group of groups) {
      let message: string;
      try {
        message = renderPaymentTemplate(templateText, group);
      } catch (err) {
        // A group whose message cannot be rendered from validated source values
        // gets no draft at all.
        if (!(err instanceof PaymentTemplateError)) throw err;
        blockedGroups++;
        continue;
      }

      const result = await this.repo.upsertPaymentDraft({
        document: mapPaymentProposal(group, message, autoApprove, now),
      });
      if (result.created) created++;
      else duplicateBoundaries++;
    }

    const summary: PaymentScanResult = {
      scanned_at: now,
      cutoff_date: cambodiaDateKey(cutoff),
      source_records: rows.length,
      eligible_records: eligible.length,
      invalid_records: invalidRecords,
      groups: groups.length,
      blocked_groups: blockedGroups,
      created,
      duplicate_boundaries: duplicateBoundaries,
      auto_approved: autoApprove,
    };

    this.deps.health.last_error_code = null;
    this.deps.health.summaries.push(summary);
    Logger.info(
      `payment tracker scan: ${created} created, ${duplicateBoundaries} already covered, ` +
        `${invalidRecords} ineligible records, ${blockedGroups} blocked groups`
    );
    return summary;
  }
}
