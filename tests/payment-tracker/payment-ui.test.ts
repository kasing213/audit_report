import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { renderPage } from '../../src/api/template-helper';
import { OUTREACH_ORGS, OrgId, PAYMENT_TRACKER_ORG } from '../../src/outreach/orgs';
import { OutreachProposalDocument, OutreachStatus } from '../../src/outreach/outreach-repository';
import {
  PaymentActivationError,
  PaymentSettingsService,
} from '../../src/payment-tracker/payment-settings-service';
import {
  PaymentTemplateDocument,
  PaymentTemplateRepository,
} from '../../src/payment-tracker/payment-template-repository';
import { mapPaymentProposal } from '../../src/payment-tracker/payment-proposal-mapper';
import { InMemoryPaymentProposalStore } from '../helpers/proposal-store';
import { NOW, paymentGroupFixture } from '../helpers/payment-fixtures';

async function renderOutreachForOrg(org: OrgId): Promise<string> {
  return renderPage('crm/outreach', {
    activeOrg: org,
    orgs: OUTREACH_ORGS,
    isPaymentTracker: org === PAYMENT_TRACKER_ORG,
  });
}

function paymentProposalFixture(id: string, status: OutreachStatus): OutreachProposalDocument {
  return {
    ...mapPaymentProposal(paymentGroupFixture(), 'payment reminder', false, NOW),
    _id: new ObjectId(id),
    status,
  };
}

function proposalFixture(id: string, org: OrgId, status: OutreachStatus): OutreachProposalDocument {
  return {
    ...mapPaymentProposal(paymentGroupFixture(), 'sales draft', false, NOW),
    _id: new ObjectId(id),
    org_id: org,
    type: 'sales',
    payment_dedupe_key: null,
    status,
  };
}

function paymentSettingsApiFixture(seed: OutreachProposalDocument[] = []) {
  let templateDocument: PaymentTemplateDocument | null = null;
  const templates = new PaymentTemplateRepository(
    {
      findOne: async () => templateDocument,
      replaceOne: async (_filter, document) => { templateDocument = structuredClone(document); },
    },
    () => NOW
  );
  let autoApprove = false;
  const workerState = {
    getAutoApprove: async () => autoApprove,
    setAutoApprove: async (_orgId: OrgId, enabled: boolean) => { autoApprove = enabled; },
  };
  const proposals = new InMemoryPaymentProposalStore(seed);
  const service = new PaymentSettingsService({ templates, workerState, proposals });
  return {
    proposals,
    putTemplate: (text: string, actor: string) => service.saveTemplate(text, actor),
    approveTemplate: (actor: string) => service.approveTemplate(actor),
    enableAuto: async () => {
      try {
        await service.setAutoApprove(true, 'developer');
        return { status: 200 };
      } catch (error) {
        return { status: error instanceof PaymentActivationError ? 409 : 500 };
      }
    },
  };
}

test('Payment workspace renders payment controls and hides sales generation controls', async () => {
  const html = await renderOutreachForOrg('payment_tracker');
  assert.match(html, /Payment reminder wording/);
  assert.match(html, /Approve wording/);
  assert.match(html, /Source verification/);
  assert.doesNotMatch(html, /Generate batch/);
  assert.doesNotMatch(html, /Retry deferred/);
});

test('Company workspace keeps existing sales controls', async () => {
  const html = await renderOutreachForOrg('company');
  assert.match(html, /Generate/);
  assert.match(html, /Retry deferred/);
  assert.doesNotMatch(html, /Payment reminder wording/);
});

test('editing wording revokes UI approval and Auto cannot enable until reapproved', async () => {
  const fixture = paymentSettingsApiFixture();
  await fixture.putTemplate('Pay {{amount_due}} {{currency}}', 'developer');
  assert.equal((await fixture.enableAuto()).status, 409);
  await fixture.approveTemplate('developer');
  assert.equal((await fixture.enableAuto()).status, 200);
});

test('enabling Payment Auto approves all existing Payment Pending drafts only', async () => {
  const fixture = paymentSettingsApiFixture([
    paymentProposalFixture('64b000000000000000000003', 'pending'),
    paymentProposalFixture('64b000000000000000000004', 'pending'),
    proposalFixture('64b000000000000000000001', 'company', 'pending'),
  ]);
  await fixture.putTemplate('Pay {{amount_due}} {{currency}}', 'developer');
  await fixture.approveTemplate('developer');
  assert.equal((await fixture.enableAuto()).status, 200);
  assert.deepEqual(
    fixture.proposals.documents.filter((p) => p.org_id === 'payment_tracker').map((p) => p.status),
    ['approved', 'approved']
  );
  assert.equal(fixture.proposals.documents.find((p) => p.org_id === 'company')?.status, 'pending');
});
