/**
 * Deterministic Payment Tracker fixtures shared by every payment test.
 *
 * One base receivable, extended only through the `overrides` argument, so a
 * test that cares about (say) credit validity changes exactly that field and
 * inherits a known-good everything else. NOW/CUTOFF are frozen instants: the
 * base AR is due 2026-09-04 Cambodia time and sendable from 2026-09-03T17:00Z.
 */
import { PaymentGroup, RawPaymentAr } from '../../src/payment-tracker/payment-types';
import { groupPaymentArs, validatePaymentAr } from '../../src/payment-tracker/payment-domain';

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
