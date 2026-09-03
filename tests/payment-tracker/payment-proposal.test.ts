import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { OutreachRepository } from '../../src/outreach/outreach-repository';
import { mapPaymentProposal } from '../../src/payment-tracker/payment-proposal-mapper';
import { paymentFingerprint } from '../../src/payment-tracker/payment-domain';
import {
  InMemoryPaymentProposalStore,
  RecordingProposalCollection,
  makeInMemoryProposalRepo,
} from '../helpers/proposal-store';
import { NOW, paymentGroupFixture } from '../helpers/payment-fixtures';

const PROPOSAL_ID = '64b000000000000000000003';

test('every ID lookup and mutation includes proposal id and exact worker org', async () => {
  const collection = new RecordingProposalCollection();
  const repo = new OutreachRepository(collection);
  await repo.getById(PROPOSAL_ID, 'payment_tracker');
  assert.deepEqual(collection.lastFilter, { _id: new ObjectId(PROPOSAL_ID), org_id: 'payment_tracker' });
  await repo.markFailed(PROPOSAL_ID, 'payment_tracker', 'privacy');
  assert.deepEqual(collection.lastFilter, { _id: new ObjectId(PROPOSAL_ID), org_id: 'payment_tracker' });
});

test('legacy company lookup retains company compatibility match', async () => {
  const collection = new RecordingProposalCollection();
  await new OutreachRepository(collection).getById(PROPOSAL_ID, 'company');
  assert.deepEqual(collection.lastFilter, {
    _id: new ObjectId(PROPOSAL_ID),
    org_id: { $in: [null, 'company'] },
  });
});

test('payment proposal maps the complete audited source snapshot', () => {
  const document = mapPaymentProposal(paymentGroupFixture(), 'message', false, NOW);
  assert.equal(document.type, 'payment');
  assert.equal(document.org_id, 'payment_tracker');
  assert.deepEqual(document.referenced_ar_ids, ['AR-1', 'AR-2']);
  assert.equal(document.payment_dedupe_key, 'payment_tracker|+85512345678|2026-09-04');
  assert.equal(document.source_fingerprint, paymentFingerprint(paymentGroupFixture()));
  assert.equal(document.status, 'pending');
  assert.equal(document.verification_state, 'not_verified');
  assert.equal(document.send_not_before?.toISOString(), '2026-09-03T17:00:00.000Z');
});

test('same payment phone and due date cannot be inserted twice', async () => {
  const store = new InMemoryPaymentProposalStore();
  const repo = makeInMemoryProposalRepo(store);
  assert.equal((await repo.upsertPaymentDraft(paymentDraftInput())).created, true);
  assert.equal((await repo.upsertPaymentDraft(paymentDraftInput())).created, false);
  assert.equal(await repo.countByDedupeKey('payment_tracker|+85512345678|2026-09-04'), 1);
  assert.equal(await store.countByDedupeKey('payment_tracker|+85512345678|2026-09-04'), 1);
});

test('Payment rejection is an auditable cancellation that retains its dedupe boundary', async () => {
  const repo = makeInMemoryProposalRepo();
  const created = await repo.upsertPaymentDraft(paymentDraftInput());
  await repo.cancelPayment(String(created.proposal?._id), 'payment_tracker', 'operator rejected', 'manager');
  const cancelled = await repo.getById(String(created.proposal?._id), 'payment_tracker');
  assert.equal(cancelled?.status, 'cancelled');
  assert.equal(cancelled?.cancelled_reason, 'operator rejected');
  assert.equal(cancelled?.cancelled_by, 'manager');
  assert.equal(cancelled?.payment_dedupe_key, 'payment_tracker|+85512345678|2026-09-04');
});

test('a cancelled boundary still blocks a later reminder for the same phone and due date', async () => {
  const repo = makeInMemoryProposalRepo();
  const created = await repo.upsertPaymentDraft(paymentDraftInput());
  await repo.cancelPayment(String(created.proposal?._id), 'payment_tracker', 'operator rejected', 'manager');
  assert.equal((await repo.upsertPaymentDraft(paymentDraftInput())).created, false);
});

test('clearing one workspace leaves the others intact', async () => {
  const store = new InMemoryPaymentProposalStore();
  const repo = makeInMemoryProposalRepo(store);
  await repo.upsertPaymentDraft(paymentDraftInput());
  await repo.insertMany([
    { ...mapPaymentProposal(paymentGroupFixture(), 'company draft', false, NOW), org_id: 'company', type: 'sales', payment_dedupe_key: null },
  ]);
  assert.equal(await repo.deleteAll('payment_tracker'), 1);
  assert.deepEqual(store.documents.map((document) => document.org_id), ['company']);
});

function paymentDraftInput() {
  return { document: mapPaymentProposal(paymentGroupFixture(), 'message', false, NOW) };
}
