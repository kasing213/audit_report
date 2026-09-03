/**
 * Turns a validated receivable group into a stored proposal.
 *
 * The proposal carries a complete snapshot of what was read — per-AR amounts,
 * credits, statuses, and the fingerprint over all of them — rather than just
 * the rendered message. That is what makes a sent reminder auditable months
 * later: the source can change, but the record of what we based the message on
 * cannot.
 */
import { OutreachProposalDocument } from '../outreach/outreach-repository';
import { PAYMENT_TRACKER_ORG } from '../outreach/orgs';
import { PaymentGroup } from './payment-types';
import { paymentDedupeKey, paymentFingerprint } from './payment-domain';

/** Recorded as the approver when Payment Auto approves a draft without a human. */
export const PAYMENT_AUTO_ACTOR = 'payment-auto';

export function mapPaymentProposal(
  group: PaymentGroup,
  message: string,
  autoApprove: boolean,
  now: Date
): OutreachProposalDocument {
  return {
    org_id: PAYMENT_TRACKER_ORG,
    type: 'payment',
    // Payment drafts are not batched by a generation run the way sales drafts
    // are; the dedupe key is the identity that matters.
    generation_id: `payment-${group.dueDate}`,
    customer_phone: group.primaryPhone,
    customer_name: group.customerNames[0] ?? null,
    // Sales-only provenance fields. Kept null rather than invented so a payment
    // proposal never looks like it came out of lead scoring.
    reason_code: null,
    days_since_contact: null,
    follower: null,
    message,
    reasoning: '',
    status: autoApprove ? 'approved' : 'pending',
    skipped_reason: null,
    failed_reason: null,
    custom_image_id: null,
    created_at: now,
    approved_at: autoApprove ? now : null,
    approved_by: autoApprove ? PAYMENT_AUTO_ACTOR : null,
    sent_at: null,
    lease_expires_at: null,
    model: 'payment-tracker',

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
    source_fingerprint: paymentFingerprint(group),
    payment_dedupe_key: paymentDedupeKey(group.primaryPhone, group.dueDate),
    // Drafted ahead of time, but not sendable until local midnight on the due
    // date — and even then only after a fresh source read at claim time.
    send_not_before: group.sendNotBefore,
    verification_state: 'not_verified',
    verified_at: null,
    verification_error: null,
    cancelled_at: null,
    cancelled_reason: null,
    cancelled_by: null,
  };
}
