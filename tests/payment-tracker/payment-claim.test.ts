import test from 'node:test';
import assert from 'node:assert/strict';
import { PaymentClaimService } from '../../src/payment-tracker/payment-claim-service';
import { PaymentGroup, RawPaymentAr } from '../../src/payment-tracker/payment-types';
import { renderPaymentTemplate } from '../../src/payment-tracker/payment-template';
import {
  NOW,
  approvedTemplateFixture,
  arrayBackedPaymentSource,
  paymentGroupFixture,
  rawAr,
  seededApprovedPaymentProposalStore,
  validatedArToRawFixture,
} from '../helpers/payment-fixtures';

interface ClaimFixtureOptions {
  now?: Date;
  autoApprove?: boolean;
  liveRows?: RawPaymentAr[];
  sourceError?: Error;
}

function paymentClaimFixture(options: ClaimFixtureOptions = {}) {
  const proposalStore = seededApprovedPaymentProposalStore(paymentGroupFixture());
  const sourceRows = options.liveRows ?? paymentGroupFixture().ars.map(validatedArToRawFixture);
  const service = new PaymentClaimService({
    proposals: proposalStore,
    source: arrayBackedPaymentSource(sourceRows, options.sourceError),
    workerState: { getAutoApprove: async () => options.autoApprove === true },
    clock: () => options.now ?? NOW,
    verificationLeaseMs: 60_000,
    claimLeaseMs: 300_000,
    renderMessage: (group: PaymentGroup) =>
      renderPaymentTemplate(approvedTemplateFixture(true).template_text, group),
  });
  return Object.assign(service, {
    proposal: proposalStore.documents[0],
    oldProposal: proposalStore.documents[0],
    proposals: proposalStore.documents,
  });
}

const sourceOutageFixture = () => paymentClaimFixture({ sourceError: new Error('source unavailable') });
const unknownStatusFixture = () => paymentClaimFixture({ liveRows: [rawAr({ current_status: 'UNKNOWN' })] });
const malformedMoneyFixture = () => paymentClaimFixture({ liveRows: [rawAr({ amount: null })] });
const mixedCurrencyFixture = () => paymentClaimFixture({ liveRows: [rawAr({ ar_id: 'AR-1' }), rawAr({ ar_id: 'AR-2', amount: { value: 100, currency: 'KHR' }, credit_applied: { value: 0, currency: 'KHR' } })] });

test('cannot claim before Cambodia due-date midnight', async () => {
  const service = paymentClaimFixture({ now: new Date('2026-09-03T16:59:59.999Z') });
  assert.equal((await service.claim()).proposal, null);
});

test('unchanged fully verified proposal becomes in_flight', async () => {
  const service = paymentClaimFixture({ now: new Date('2026-09-03T17:00:00.000Z') });
  const result = await service.claim();
  assert.equal(result.proposal?.status, 'in_flight');
  assert.equal(result.proposal?.verification_state, 'verified');
});

test('all referenced ARs becoming paid cancels before send', async () => {
  const service = paymentClaimFixture({ liveRows: [rawAr({ ar_id: 'AR-1', current_status: 'PAID' }), rawAr({ ar_id: 'AR-2', current_status: 'PAID' })] });
  const result = await service.claim();
  assert.equal(result.proposal, null);
  assert.equal(service.proposal.status, 'cancelled');
  assert.equal(service.proposal.cancelled_reason, 'all_referenced_ars_ineligible');
});

test('manual source change clears approval and returns refreshed proposal to pending', async () => {
  const service = paymentClaimFixture({ autoApprove: false, liveRows: [rawAr({ ar_id: 'AR-1', amount: { value: 130, currency: 'USD' } })] });
  await service.claim();
  assert.equal(service.proposal.status, 'pending');
  assert.equal(service.proposal.approved_at, null);
  assert.equal(service.proposal.payment_balance_due, 110);
});

test('auto source change stays approved but is not returned until another verification', async () => {
  const service = paymentClaimFixture({ autoApprove: true, liveRows: [rawAr({ ar_id: 'AR-1', amount: { value: 130, currency: 'USD' } })] });
  assert.equal((await service.claim()).proposal, null);
  assert.equal(service.proposal.status, 'approved');
  assert.equal(service.proposal.approved_by, 'payment-auto');
});

test('phone or due-date change supersedes old boundary and preserves both audit records', async () => {
  const service = paymentClaimFixture({ liveRows: [rawAr({ ar_id: 'AR-1', customer_phone: ['099999999'] })] });
  await service.claim();
  assert.equal(service.oldProposal.status, 'cancelled');
  assert.equal(service.oldProposal.cancelled_reason, 'source_boundary_changed');
  assert.equal(service.proposals.length, 2);
});

test('outage, unknown status, malformed money, and mixed currencies return no claim', async () => {
  for (const fixture of [sourceOutageFixture(), unknownStatusFixture(), malformedMoneyFixture(), mixedCurrencyFixture()]) {
    const result = await fixture.claim();
    assert.equal(result.proposal, null);
    assert.equal(fixture.proposal.verification_state, 'blocked');
  }
});

test('a blocked proposal backs off instead of being retried immediately', async () => {
  const fixture = unknownStatusFixture();
  await fixture.claim();
  assert.ok((fixture.proposal.verification_retry_after as Date) > NOW);
  // Second attempt at the same instant finds nothing due, rather than looping.
  assert.equal((await fixture.claim()).proposal, null);
});

test('concurrent claims return a proposal to only one caller', async () => {
  const service = paymentClaimFixture();
  const results = await Promise.all([service.claim(), service.claim()]);
  assert.equal(results.filter((result) => result.proposal).length, 1);
});
