import test from 'node:test';
import assert from 'node:assert/strict';
import { readLeadControlConfig } from '../../src/lead-control/config';

// Production mutation caught: either gate defaults on, exposing writes/source reads on deployment.
test('Lead Control defaults to read-only with source sync disabled at a 15-minute interval', () => {
  assert.deepEqual(readLeadControlConfig({}), {
    writesEnabled: false,
    syncEnabled: false,
    syncIntervalMinutes: 15,
  });
});

// Production mutation caught: permissive boolean parsing enables a sensitive path for TRUE/1/yes.
test('Lead Control writes and sync enable only for the exact string true', () => {
  for (const value of ['TRUE', 'True', '1', 'yes', ' true', 'true ']) {
    assert.equal(readLeadControlConfig({ LEAD_CONTROL_WRITES_ENABLED: value }).writesEnabled, false);
    assert.equal(readLeadControlConfig({ LEAD_CONTROL_SYNC_ENABLED: value }).syncEnabled, false);
  }
  assert.equal(readLeadControlConfig({ LEAD_CONTROL_WRITES_ENABLED: 'true' }).writesEnabled, true);
  assert.equal(readLeadControlConfig({ LEAD_CONTROL_SYNC_ENABLED: 'true' }).syncEnabled, true);
});

// Production mutation caught: an unsafe, fractional, or non-numeric source polling interval reaches cron.
test('Lead Control rejects sync intervals outside the documented safe integer range', () => {
  for (const value of ['4', '61', '15.5', 'not-a-number']) {
    assert.throws(
      () => readLeadControlConfig({ LEAD_CONTROL_SYNC_INTERVAL_MINUTES: value }),
      /LEAD_CONTROL_SYNC_INTERVAL_MINUTES must be an integer from 5 through 60/,
    );
  }
  assert.equal(readLeadControlConfig({ LEAD_CONTROL_SYNC_INTERVAL_MINUTES: '5' }).syncIntervalMinutes, 5);
  assert.equal(readLeadControlConfig({ LEAD_CONTROL_SYNC_INTERVAL_MINUTES: '60' }).syncIntervalMinutes, 60);
});
