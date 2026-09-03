/**
 * Claim-time live verification for Payment Tracker.
 *
 * A payment draft can sit approved for hours or days before a worker asks for
 * it, and in that window the customer may have paid. So nothing is handed to a
 * worker on the strength of what was true at scan time: every claim re-reads
 * the source, re-applies the exact same domain rules, and only sends if
 * everything still matches.
 *
 * The read is deliberately two queries. Re-reading the referenced ar_ids
 * catches receivables that changed or were settled; re-reading all eligible
 * receivables for that due date catches ones that JOINED the customer's group
 * after the draft was written. Either alone would miss half the picture.
 *
 * Every uncertain outcome — outage, unknown status, unreadable money, mixed
 * currency, ambiguous grouping — blocks rather than sends. Blocking is
 * recoverable; a wrong payment reminder is not.
 */
import { Logger } from '../utils/logger';
import { PAYMENT_TRACKER_ORG } from '../outreach/orgs';
import {
  OutreachProposalDocument,
  OutreachRepository,
  ProposalCollectionPort,
  RefreshedPaymentFields,
} from '../outreach/outreach-repository';
import { PaymentGroup, RawPaymentAr, ValidatedPaymentAr } from './payment-types';
import {
  endOfTomorrowCambodia,
  groupPaymentArs,
  paymentDedupeKey,
  paymentFingerprint,
  validatePaymentAr,
} from './payment-domain';
import { mapPaymentProposal } from './payment-proposal-mapper';

/** Backoff after a blocked verification, so one bad record cannot hot-loop. */
const BLOCKED_RETRY_MS = 10 * 60 * 1000;

/**
 * Source statuses that mean "this receivable is legitimately done with".
 * A status outside both this set and the eligible set is NOT settled — it is
 * unrecognised, which is a reason to stop and look, not to cancel a reminder.
 */
const SETTLED_STATUSES = ['PAID', 'CANCELLED', 'CANCELED', 'WRITTEN_OFF', 'WRITTENOFF', 'VOID'];

/**
 * Validation failures that mean the receivable no longer needs chasing, as
 * opposed to ones that mean we could not read it. Only these contribute to
 * cancellation; everything else blocks.
 */
const SETTLED_CODES = ['no_positive_balance'];

export interface PaymentArSource {
  findByArIds(arIds: string[]): Promise<RawPaymentAr[]>;
  findCandidatesForDate(localDate: string): Promise<RawPaymentAr[]>;
}

export interface PaymentClaimDependencies {
  proposals: ProposalCollectionPort;
  source: PaymentArSource;
  workerState: { getAutoApprove(): Promise<boolean> };
  clock: () => Date;
  verificationLeaseMs: number;
  claimLeaseMs: number;
  /**
   * Renders the reminder for a rebuilt group. Required in production: a
   * refreshed proposal whose figures moved must not keep its old wording.
   */
  renderMessage: (group: PaymentGroup) => string;
}

export interface PaymentClaimResult {
  proposal: OutreachProposalDocument | null;
  reason?: string;
}

type ArOutcome =
  | { kind: 'eligible'; ar: ValidatedPaymentAr }
  | { kind: 'settled' }
  | { kind: 'blocked'; code: string };

export class PaymentClaimService {
  private readonly repo: OutreachRepository;

  constructor(private readonly deps: PaymentClaimDependencies) {
    this.repo = new OutreachRepository(deps.proposals);
  }

  async claim(now: Date = this.deps.clock()): Promise<PaymentClaimResult> {
    const leased = await this.repo.acquirePaymentVerificationLease(
      PAYMENT_TRACKER_ORG,
      now,
      this.deps.verificationLeaseMs
    );
    if (!leased) return { proposal: null, reason: 'nothing_due' };

    const { proposal, leaseToken } = leased;
    const id = String(proposal._id);
    const dueDate = proposal.due_date;
    const referencedIds = proposal.referenced_ar_ids ?? [];

    if (!dueDate || referencedIds.length === 0) {
      return this.block(id, leaseToken, 'proposal_missing_source_reference', now);
    }

    let referencedRows: RawPaymentAr[];
    let sameDayRows: RawPaymentAr[];
    try {
      // Both reads must succeed. A partial view of the source is not a basis
      // for sending money-related messages.
      referencedRows = await this.deps.source.findByArIds(referencedIds);
      sameDayRows = await this.deps.source.findCandidatesForDate(dueDate);
    } catch (err) {
      Logger.error('payment claim source reread failed', err as Error);
      return this.block(id, leaseToken, 'source_unavailable', now);
    }

    const cutoff = endOfTomorrowCambodia(now);
    const byArId = new Map(referencedRows.map((row) => [String(row.ar_id), row]));

    const eligible: ValidatedPaymentAr[] = [];
    for (const arId of referencedIds) {
      const row = byArId.get(arId);
      const outcome = classifyReferencedAr(row, cutoff);
      if (outcome.kind === 'blocked') return this.block(id, leaseToken, outcome.code, now);
      if (outcome.kind === 'eligible') eligible.push(outcome.ar);
    }

    if (eligible.length === 0) {
      // Everything this reminder was about has been settled or removed.
      await this.repo.cancelPayment(id, PAYMENT_TRACKER_ORG, 'all_referenced_ars_ineligible', 'payment-verifier');
      return { proposal: null, reason: 'all_referenced_ars_ineligible' };
    }

    const referencedGrouping = groupPaymentArs(eligible);
    if (referencedGrouping.errors.length > 0 || referencedGrouping.groups.length !== 1) {
      // The surviving receivables no longer describe one reminder — mixed
      // currency, or they split across phones/dates. Never guess which to send.
      return this.block(id, leaseToken, referencedGrouping.errors[0]?.code ?? 'ambiguous_group', now);
    }

    const anchor = referencedGrouping.groups[0];

    // Fold in receivables that joined this customer's due date after drafting.
    const members = new Map(eligible.map((ar) => [ar.arId, ar]));
    for (const row of sameDayRows) {
      const validated = validatePaymentAr(row, cutoff);
      if (!validated.ok) continue;
      const ar = validated.ar;
      if (ar.primaryPhone !== anchor.primaryPhone || ar.dueDate !== anchor.dueDate) continue;
      members.set(ar.arId, ar);
    }

    const rebuilt = groupPaymentArs([...members.values()]);
    if (rebuilt.errors.length > 0 || rebuilt.groups.length !== 1) {
      return this.block(id, leaseToken, rebuilt.errors[0]?.code ?? 'ambiguous_group', now);
    }

    const group = rebuilt.groups[0];
    const fingerprint = paymentFingerprint(group);
    const dedupeKey = paymentDedupeKey(group.primaryPhone, group.dueDate);
    const autoApprove = await this.deps.workerState.getAutoApprove();

    if (dedupeKey !== proposal.payment_dedupe_key) {
      return this.supersede(proposal, group, autoApprove, now, leaseToken);
    }

    if (fingerprint !== proposal.source_fingerprint) {
      return this.refresh(id, leaseToken, group, fingerprint, autoApprove, now);
    }

    // Unchanged and verified. One compare-and-set flips it to in_flight; if
    // anything moved since the reread, this matches nothing and nothing sends.
    const claimed = await this.repo.finalizeVerifiedPaymentClaim(
      id,
      PAYMENT_TRACKER_ORG,
      leaseToken,
      fingerprint,
      new Date(now.getTime() + this.deps.claimLeaseMs),
      now
    );
    if (!claimed) return { proposal: null, reason: 'claim_conflict' };
    return { proposal: claimed };
  }

  /**
   * The dedupe boundary itself moved — a different phone or a different due
   * date. That is a different reminder, so the old proposal is cancelled as
   * superseded and a new one is drafted. Both records survive, which is what
   * keeps the audit trail intact.
   */
  private async supersede(
    proposal: OutreachProposalDocument,
    group: PaymentGroup,
    autoApprove: boolean,
    now: Date,
    leaseToken: string
  ): Promise<PaymentClaimResult> {
    const id = String(proposal._id);
    await this.repo.cancelPayment(id, PAYMENT_TRACKER_ORG, 'source_boundary_changed', 'payment-verifier');
    await this.repo.releasePaymentVerificationLease(id, PAYMENT_TRACKER_ORG, leaseToken, {
      state: 'not_verified',
      errorCode: null,
      retryAfter: null,
    });

    await this.repo.upsertPaymentDraft({
      document: mapPaymentProposal(group, this.deps.renderMessage(group), autoApprove, now),
    });

    // Never returned in the same request: the replacement has its own due-date
    // gate and must pass its own verification.
    return { proposal: null, reason: 'source_boundary_changed' };
  }

  /** Same boundary, different figures. Rewrite in place, do not send yet. */
  private async refresh(
    id: string,
    leaseToken: string,
    group: PaymentGroup,
    fingerprint: string,
    autoApprove: boolean,
    now: Date
  ): Promise<PaymentClaimResult> {
    const refreshed: RefreshedPaymentFields = {
      message: this.deps.renderMessage(group),
      customer_phone: group.primaryPhone,
      customer_name: group.customerNames[0] ?? null,
      billing_month: group.billingMonth,
      due_date: group.dueDate,
      referenced_ar_ids: group.arIds,
      home_references: group.homeReferences,
      customer_names: group.customerNames,
      payment_currency: group.currency,
      payment_amount_total: group.amountTotal,
      payment_credit_total: group.creditTotal,
      payment_balance_due: group.balanceDue,
      payment_ar_details: group.ars,
      source_fingerprint: fingerprint,
      send_not_before: group.sendNotBefore,
    };

    await this.repo.refreshPaymentProposal(
      id,
      PAYMENT_TRACKER_ORG,
      leaseToken,
      refreshed,
      autoApprove ? 'auto' : 'manual',
      now
    );
    return { proposal: null, reason: 'source_changed' };
  }

  /** Record why we could not verify, back off, and send nothing. */
  private async block(
    id: string,
    leaseToken: string,
    code: string,
    now: Date
  ): Promise<PaymentClaimResult> {
    await this.repo.releasePaymentVerificationLease(id, PAYMENT_TRACKER_ORG, leaseToken, {
      state: 'blocked',
      errorCode: code,
      retryAfter: new Date(now.getTime() + BLOCKED_RETRY_MS),
    });
    return { proposal: null, reason: code };
  }
}

/**
 * Decide what one referenced receivable means now.
 *
 * The distinction that matters: a receivable that is missing or explicitly
 * settled is a reason to CANCEL the reminder, while one we could not read or
 * whose status we do not recognise is a reason to STOP. Collapsing those two
 * would either send against unreadable data or quietly cancel real debts.
 */
function classifyReferencedAr(row: RawPaymentAr | undefined, cutoff: Date): ArOutcome {
  // Referenced but absent from the source: it is gone, not unreadable.
  if (!row) return { kind: 'settled' };

  const validated = validatePaymentAr(row, cutoff);
  if (validated.ok) return { kind: 'eligible', ar: validated.ar };

  if (validated.code === 'ineligible_status') {
    const status = typeof row.current_status === 'string' ? row.current_status.trim().toUpperCase() : '';
    return SETTLED_STATUSES.includes(status)
      ? { kind: 'settled' }
      : { kind: 'blocked', code: 'unknown_source_status' };
  }

  if (SETTLED_CODES.includes(validated.code)) return { kind: 'settled' };

  return { kind: 'blocked', code: validated.code };
}
