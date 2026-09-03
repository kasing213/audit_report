import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cambodiaDateKey,
  cambodiaStartOfDate,
  endOfTomorrowCambodia,
  groupPaymentArs,
  paymentDedupeKey,
  paymentFingerprint,
  validatePaymentAr,
} from '../../src/payment-tracker/payment-domain';
import { rawAr } from '../helpers/payment-fixtures';

test('Cambodia boundaries use local calendar dates', () => {
  const now = new Date('2026-09-03T16:59:59.000Z');
  assert.equal(cambodiaDateKey(now), '2026-09-03');
  assert.equal(cambodiaDateKey(new Date(now.getTime() + 1000)), '2026-09-04');
  assert.equal(cambodiaStartOfDate('2026-09-04').toISOString(), '2026-09-03T17:00:00.000Z');
  assert.equal(endOfTomorrowCambodia(now).toISOString(), '2026-09-04T16:59:59.999Z');
});

test('selects only the first valid normalized source phone', () => {
  const result = validatePaymentAr(rawAr(), new Date('2026-09-04T16:59:59.999Z'));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.ar.primaryPhone, '+85512345678');
});

test('validates currency before calculating a positive balance', () => {
  const valid = validatePaymentAr(rawAr(), new Date('2026-09-04T16:59:59.999Z'));
  assert.equal(valid.ok && valid.ar.amountDue, 100);
  for (const changed of [
    { credit_applied: null },
    { credit_applied: { value: 20, currency: 'KHR' } },
    { amount: { value: -1, currency: 'USD' } },
    { credit_applied: { value: Number.NaN, currency: 'USD' } },
    { current_status: 'PAID' },
    { current_status: 'UNKNOWN' },
  ]) {
    assert.equal(validatePaymentAr(rawAr(changed), new Date('2026-09-04T16:59:59.999Z')).ok, false);
  }
  assert.equal(validatePaymentAr(rawAr({ credit_applied: { value: 200, currency: 'USD' } }), new Date('2026-09-04T16:59:59.999Z')).ok, false);
});

test('groups by phone and exact due date and rejects mixed currency', () => {
  const cutoff = new Date('2026-09-04T16:59:59.999Z');
  const a = validatePaymentAr(rawAr({ ar_id: 'AR-2' }), cutoff);
  const b = validatePaymentAr(rawAr({ ar_id: 'AR-1', amount: { value: 80, currency: 'USD' }, credit_applied: { value: 5, currency: 'USD' } }), cutoff);
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  const grouped = groupPaymentArs([a.ar, b.ar]);
  assert.equal(grouped.groups.length, 1);
  assert.deepEqual(grouped.groups[0].arIds, ['AR-1', 'AR-2']);
  assert.equal(grouped.groups[0].balanceDue, 175);
  const khr = { ...b.ar, arId: 'AR-3', currency: 'KHR' };
  assert.equal(groupPaymentArs([a.ar, khr]).errors[0].code, 'mixed_currency');
});

test('fingerprint is order-independent and changes with every protected source field', () => {
  const cutoff = new Date('2026-09-04T16:59:59.999Z');
  const a = validatePaymentAr(rawAr({ ar_id: 'AR-2' }), cutoff);
  const b = validatePaymentAr(rawAr({ ar_id: 'AR-1' }), cutoff);
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  const g1 = groupPaymentArs([a.ar, b.ar]).groups[0];
  const g2 = groupPaymentArs([b.ar, a.ar]).groups[0];
  assert.equal(paymentFingerprint(g1), paymentFingerprint(g2));
  assert.notEqual(paymentFingerprint(g1), paymentFingerprint({ ...g1, ars: g1.ars.map((item, i) => i ? item : { ...item, status: 'OVERDUE' as const }) }));
  assert.equal(paymentDedupeKey(g1.primaryPhone, g1.dueDate), 'payment_tracker|+85512345678|2026-09-04');
});
