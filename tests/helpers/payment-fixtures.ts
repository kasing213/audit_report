/**
 * Deterministic Payment Tracker fixtures shared by every payment test.
 *
 * One base receivable, extended only through the `overrides` argument, so a
 * test that cares about (say) credit validity changes exactly that field and
 * inherits a known-good everything else. NOW/CUTOFF are frozen instants: the
 * base AR is due 2026-09-04 Cambodia time and sendable from 2026-09-03T17:00Z.
 */
import { PaymentGroup, RawPaymentAr } from '../../src/payment-tracker/payment-types';
import { PaymentTemplateDocument } from '../../src/payment-tracker/payment-template-repository';
import { PaymentArSnapshot, ValidatedPaymentAr } from '../../src/payment-tracker/payment-types';
import { OutreachProposalDocument } from '../../src/outreach/outreach-repository';
import {
  cambodiaStartOfDate,
  groupPaymentArs,
  validatePaymentAr,
} from '../../src/payment-tracker/payment-domain';
import { mapPaymentProposal } from '../../src/payment-tracker/payment-proposal-mapper';
import { InMemoryPaymentProposalStore } from './proposal-store';

export const NOW = new Date('2026-09-03T17:00:00.000Z');
export const CUTOFF = new Date('2026-09-04T16:59:59.999Z');

export function rawAr(overrides: Partial<Record<keyof RawPaymentAr, unknown>> = {}): RawPaymentAr {
  return {
    ar_id: 'AR-2',
    home_id: 'H-2',
    customer_name: 'Sokha',
    // First entry is unnormalizable and the third is a different number: proves
    // selection takes the FIRST VALID entry, not the first or the last.
    customer_phone: ['invalid', '012 345 678', '099999999'],
    current_status: 'PENDING',
    amount: { value: 120, currency: 'usd' },
    credit_applied: { value: 20, currency: 'USD' },
    due_date: new Date('2026-09-04T00:00:00.000Z'),
    ...overrides,
  };
}

/** Two ARs sharing a phone and due date — the canonical grouped proposal. */
export function paymentGroupFixture(): PaymentGroup {
  const first = validatePaymentAr(rawAr({ ar_id: 'AR-2', home_id: 'H-2', customer_name: 'Dara' }), CUTOFF);
  const second = validatePaymentAr(rawAr({ ar_id: 'AR-1', home_id: 'H-1', customer_name: 'Sokha', amount: { value: 80, currency: 'USD' }, credit_applied: { value: 5, currency: 'USD' } }), CUTOFF);
  if (!first.ok || !second.ok) throw new Error('invalid payment fixture');
  return groupPaymentArs([first.ar, second.ar]).groups[0];
}

/**
 * Payment wording in one of its two meaningful states. Unapproved wording must
 * block scanning and Payment Auto, so tests take the flag explicitly rather
 * than defaulting to the happy path.
 */
export function approvedTemplateFixture(approved: boolean): PaymentTemplateDocument {
  return {
    _id: 'payment_tracker',
    template_text: 'Pay {{amount_due}} {{currency}} by {{due_date}} for {{ar_references}}',
    updated_at: new Date('2026-09-03T00:00:00.000Z'),
    updated_by: 'developer',
    approved_at: approved ? new Date('2026-09-03T00:01:00.000Z') : null,
    approved_by: approved ? 'developer' : null,
  };
}

/**
 * Exact reverse of validatePaymentAr, so a live source read can be built from a
 * group the scanner already produced. Deliberately lossless and deliberately
 * NOT lenient: the round trip must survive production validation unchanged, or
 * the fingerprint comparison the claim path relies on would be meaningless.
 */
export function validatedArToRawFixture(ar: PaymentArSnapshot): RawPaymentAr {
  return {
    ar_id: ar.arId,
    home_id: ar.homeId,
    customer_name: ar.customerName,
    customer_phone: [ar.primaryPhone],
    current_status: ar.status,
    amount: { value: ar.amountValue, currency: ar.currency },
    credit_applied: { value: ar.creditValue, currency: ar.currency },
    due_date: cambodiaStartOfDate(ar.dueDate),
  };
}

/** One approved, human-approved payment proposal ready to be claimed. */
export function seededApprovedPaymentProposalStore(group: PaymentGroup): InMemoryPaymentProposalStore {
  const document: OutreachProposalDocument = {
    ...mapPaymentProposal(group, 'reminder', false, NOW),
    status: 'approved',
    approved_at: new Date('2026-09-03T10:00:00.000Z'),
    approved_by: 'developer',
  };
  return new InMemoryPaymentProposalStore([document]);
}

/**
 * Array-backed live source. findByArIds returns whatever rows exist for those
 * ids — a referenced id with no row is genuinely missing, which is a distinct
 * outcome from an ineligible one and must stay distinguishable.
 */
export function arrayBackedPaymentSource(rows: RawPaymentAr[], error?: Error) {
  const reject = async (): Promise<never> => {
    throw error as Error;
  };
  return {
    findByArIds: async (arIds: string[]): Promise<RawPaymentAr[]> => {
      if (error) return reject();
      return rows.filter((row) => arIds.includes(String(row.ar_id)));
    },
    findCandidatesForDate: async (localDate: string): Promise<RawPaymentAr[]> => {
      if (error) return reject();
      return rows.filter((row) => {
        const validated = validatePaymentAr(row, CUTOFF);
        return validated.ok && validated.ar.dueDate === localDate;
      });
    },
  };
}

/** Narrow the domain type for fixtures that build ARs by hand. */
export type FixtureAr = ValidatedPaymentAr;
