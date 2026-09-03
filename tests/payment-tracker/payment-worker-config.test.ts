import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { requireWorkerOrgId } from '../../scripts/telegram-worker/worker-config';
import { resolvePaymentSessionTarget } from '../../scripts/telegram-worker/payment-session-guard';

test('worker refuses missing and invalid ORG_ID before network activity', () => {
  assert.throws(() => requireWorkerOrgId(undefined), /ORG_ID must be explicitly set/);
  assert.throws(() => requireWorkerOrgId('unknown'), /invalid ORG_ID/);
  assert.equal(requireWorkerOrgId('company'), 'company');
  assert.equal(requireWorkerOrgId('personal'), 'personal');
  assert.equal(requireWorkerOrgId('payment_tracker'), 'payment_tracker');
});

test('payment login permits only the exact payment session file', () => {
  const cwd = path.resolve('scripts/telegram-worker');
  assert.equal(
    resolvePaymentSessionTarget(cwd, './telegram-string-session-payment-tracker.txt'),
    path.join(cwd, 'telegram-string-session-payment-tracker.txt')
  );
  for (const target of ['./telegram-string-session.txt', './telegram-string-session-personal.txt', '../payment.txt']) {
    assert.throws(() => resolvePaymentSessionTarget(cwd, target));
  }
});

test('payment PM2 configuration contains only the isolated Payment app', () => {
  const config = require('../../scripts/telegram-worker/ecosystem.payment-tracker.config.js');
  assert.deepEqual(config.apps.map((app: { name: string }) => app.name), ['outreach-worker-payment-tracker']);
  assert.equal(config.apps[0].env.ORG_ID, 'payment_tracker');
  assert.equal(config.apps[0].env.STRING_SESSION_PATH, './telegram-string-session-payment-tracker.txt');
  assert.equal(config.apps[0].env.DAILY_CAP, '15');
});

test('the Company/Personal PM2 file still defines exactly its two workers', () => {
  const config = require('../../scripts/telegram-worker/ecosystem.config.js');
  assert.deepEqual(
    config.apps.map((app: { name: string }) => app.name),
    ['outreach-worker-company', 'outreach-worker-personal']
  );
});
