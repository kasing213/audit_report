import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PaymentScanResult,
  PaymentTrackerScanner,
} from '../../src/payment-tracker/payment-scanner';
import { RawPaymentAr } from '../../src/payment-tracker/payment-types';
import { InMemoryPaymentProposalStore } from '../helpers/proposal-store';
import { NOW, approvedTemplateFixture, rawAr } from '../helpers/payment-fixtures';

const invalidCreditAr = () => rawAr({ ar_id: 'BAD-CREDIT', credit_applied: null });
const usdAr = () => rawAr({ ar_id: 'USD-1', customer_phone: ['012345678'] });
const khrArSameKey = () => rawAr({ ar_id: 'KHR-1', customer_phone: ['012345678'], amount: { value: 400000, currency: 'KHR' }, credit_applied: { value: 0, currency: 'KHR' } });
const validOtherPhoneAr = () => rawAr({ ar_id: 'OTHER-1', customer_phone: ['099999999'] });

interface ScannerFixtureOptions {
  sourceRows?: RawPaymentAr[];
  sourceError?: Error;
  autoApprove?: boolean;
  templateApproved?: boolean;
}

function scannerDeps(options: ScannerFixtureOptions) {
  const proposals = new InMemoryPaymentProposalStore();
  const health = { last_error_code: null as string | null, summaries: [] as PaymentScanResult[] };
  return {
    source: {
      findCandidates: async () => {
        if (options.sourceError) throw options.sourceError;
        return options.sourceRows ?? [];
      },
    },
    proposals,
    health,
    template: approvedTemplateFixture(options.templateApproved === true),
    workerState: { auto_approve: options.autoApprove === true },
  };
}

test('manual scan creates one pending draft for ARs sharing phone and due date', async () => {
  const deps = scannerDeps({ sourceRows: [rawAr({ ar_id: 'AR-1' }), rawAr({ ar_id: 'AR-2' })], autoApprove: false, templateApproved: true });
  const result = await new PaymentTrackerScanner(deps).run(NOW);
  assert.equal(result.created, 1);
  assert.equal(deps.proposals.documents[0].status, 'pending');
  assert.deepEqual(deps.proposals.documents[0].referenced_ar_ids, ['AR-1', 'AR-2']);
});

test('auto scan creates approved drafts only after wording approval', async () => {
  const enabled = scannerDeps({ sourceRows: [rawAr({ ar_id: 'AR-1' })], autoApprove: true, templateApproved: true });
  await new PaymentTrackerScanner(enabled).run(NOW);
  assert.equal(enabled.proposals.documents[0].status, 'approved');
  const blocked = scannerDeps({ sourceRows: [rawAr({ ar_id: 'AR-1' })], autoApprove: true, templateApproved: false });
  await assert.rejects(() => new PaymentTrackerScanner(blocked).run(NOW), /approved payment wording required/);
  assert.equal(blocked.proposals.documents.length, 0);
});

test('source outage writes no proposals and records a safe health error', async () => {
  const deps = scannerDeps({ sourceError: new Error('connection failed'), templateApproved: true });
  await assert.rejects(() => new PaymentTrackerScanner(deps).run(NOW), /connection failed/);
  assert.equal(deps.proposals.documents.length, 0);
  assert.equal(deps.health.last_error_code, 'source_unavailable');
});

test('invalid AR and mixed-currency group fail closed without blocking an unrelated valid group', async () => {
  const deps = scannerDeps({ sourceRows: [invalidCreditAr(), usdAr(), khrArSameKey(), validOtherPhoneAr()], templateApproved: true });
  const result = await new PaymentTrackerScanner(deps).run(NOW);
  assert.equal(result.created, 1);
  assert.equal(result.invalid_records, 1);
  assert.equal(result.blocked_groups, 1);
});

test('rescanning the same receivables creates no second reminder', async () => {
  const deps = scannerDeps({ sourceRows: [rawAr({ ar_id: 'AR-1' })], templateApproved: true });
  const scanner = new PaymentTrackerScanner(deps);
  await scanner.run(NOW);
  const second = await scanner.run(NOW);
  assert.equal(second.created, 0);
  assert.equal(second.duplicate_boundaries, 1);
  assert.equal(deps.proposals.documents.length, 1);
});

test('scan summaries record counts only, never customer data', async () => {
  const deps = scannerDeps({ sourceRows: [rawAr({ ar_id: 'AR-1' })], templateApproved: true });
  await new PaymentTrackerScanner(deps).run(NOW);
  const summary = JSON.stringify(deps.health.summaries[0]);
  assert.equal(deps.health.summaries.length, 1);
  assert.doesNotMatch(summary, /\+855|Sokha|Dara|AR-1|H-1/);
});
