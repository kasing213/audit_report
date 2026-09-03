import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTREACH_ORGS,
  PAYMENT_TRACKER_ORG,
  SALES_OUTREACH_ORGS,
} from '../../src/outreach/orgs';
import { strictWorkerOrg } from '../../src/outreach/org-context';

test('navigation contains payment_tracker while sales scanner orgs do not', () => {
  assert.deepEqual(OUTREACH_ORGS.map((org) => org.id), ['company', 'personal', 'payment_tracker']);
  assert.equal(PAYMENT_TRACKER_ORG, 'payment_tracker');
  assert.deepEqual(SALES_OUTREACH_ORGS.map((org) => org.id), ['company', 'personal']);
});

test('strict worker org accepts only one registered header value', () => {
  assert.equal(strictWorkerOrg('company'), 'company');
  assert.equal(strictWorkerOrg('personal'), 'personal');
  assert.equal(strictWorkerOrg('payment_tracker'), 'payment_tracker');
  assert.equal(strictWorkerOrg(undefined), null);
  assert.equal(strictWorkerOrg(''), null);
  assert.equal(strictWorkerOrg('unknown'), null);
  assert.equal(strictWorkerOrg(['company']), null);
});
