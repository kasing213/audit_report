import test from 'node:test';
import assert from 'node:assert/strict';
import { readPaymentTrackerConfig } from '../../src/payment-tracker/payment-config';

test('Payment configuration defaults are disabled, 10:00, and cap 15', () => {
  assert.deepEqual(readPaymentTrackerConfig({}), {
    scanEnabled: false,
    scanTime: '10:00',
    dailyCap: 15,
  });
});

test('invalid scan time and cap fail configuration validation', () => {
  assert.throws(() => readPaymentTrackerConfig({ PAYMENT_TRACKER_SCAN_TIME: '25:00' }));
  assert.throws(() => readPaymentTrackerConfig({ PAYMENT_TRACKER_DAILY_CAP: '0' }));
});

test('scanning is enabled only by the exact string true', () => {
  assert.equal(readPaymentTrackerConfig({ PAYMENT_TRACKER_SCAN_ENABLED: 'TRUE' }).scanEnabled, false);
  assert.equal(readPaymentTrackerConfig({ PAYMENT_TRACKER_SCAN_ENABLED: '1' }).scanEnabled, false);
  assert.equal(readPaymentTrackerConfig({ PAYMENT_TRACKER_SCAN_ENABLED: 'true' }).scanEnabled, true);
});
