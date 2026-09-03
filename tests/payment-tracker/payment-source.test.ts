import test from 'node:test';
import assert from 'node:assert/strict';
import { PaymentSourceRepository } from '../../src/payment-tracker/payment-source-repository';
import { validateSourcePrivileges } from '../../src/payment-tracker/payment-source-inspection';
import { RecordingPaymentCollection } from '../helpers/recording-collections';

test('candidate query uses current_status, BSON cutoff, phone presence, and a strict projection', async () => {
  const fake = new RecordingPaymentCollection([]);
  const repo = new PaymentSourceRepository(fake);
  const cutoff = new Date('2026-09-04T16:59:59.999Z');
  await repo.findCandidates(cutoff);
  assert.deepEqual(fake.lastFilter, {
    current_status: { $in: ['PENDING', 'OVERDUE'] },
    due_date: { $lte: cutoff },
    'customer_phone.0': { $exists: true },
  });
  assert.deepEqual(Object.keys(fake.lastProjection).sort(), [
    '_id', 'amount', 'ar_id', 'credit_applied', 'current_status',
    'customer_name', 'customer_phone', 'due_date', 'home_id',
  ]);
  assert.equal(fake.lastProjection._id, 0);
});

test('live lookup reads every referenced id regardless of status', async () => {
  const fake = new RecordingPaymentCollection([]);
  await new PaymentSourceRepository(fake).findByArIds(['AR-2', 'AR-1']);
  assert.deepEqual(fake.lastFilter, { ar_id: { $in: ['AR-1', 'AR-2'] } });
});

test('exact-date membership query uses Cambodia UTC bounds', async () => {
  const fake = new RecordingPaymentCollection([]);
  await new PaymentSourceRepository(fake).findCandidatesForDate('2026-09-04');
  assert.deepEqual(fake.lastFilter.due_date, {
    $gte: new Date('2026-09-03T17:00:00.000Z'),
    $lt: new Date('2026-09-04T17:00:00.000Z'),
  });
});

test('source privilege validation accepts only ar_state find and listIndexes', () => {
  const allowed = [
    { resource: { db: 'ar_tracker', collection: 'ar_state' }, actions: ['find', 'listIndexes'] },
  ];
  assert.equal(validateSourcePrivileges(allowed).ok, true);
  assert.equal(validateSourcePrivileges([{ resource: { db: 'ar_tracker', collection: '' }, actions: ['find'] }]).ok, false);
  assert.equal(validateSourcePrivileges([{ resource: { db: 'ar_tracker', collection: 'ar_state' }, actions: ['find', 'insert'] }]).ok, false);
  assert.equal(validateSourcePrivileges([{ resource: { db: 'admin', collection: '' }, actions: ['anyAction'] }]).ok, false);
});
