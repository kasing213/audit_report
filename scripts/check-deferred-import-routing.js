/**
 * The worker's deferred-import reason must classify as 'transient' (re-queued,
 * attempt refunded, phone stays in the pool) and never as 'privacy' (permanent
 * blacklist, next_retry_at=null). Pure function check — no database.
 *
 * Usage: node scripts/check-deferred-import-routing.js
 */
const { classifyFailure } = require('../dist/outreach/outreach-suppression-repository');

// Kept in sync with DEFERRED_IMPORT_REASON / ABSENT_PEER_REASON in
// scripts/telegram-worker/worker.ts.
const DEFERRED = 'contact import deferred by Telegram (retry later)';
const ABSENT = 'phone number not on Telegram (or hidden by privacy)';

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (got ${actual}, want ${expected})`);
}

check('deferred import -> transient (re-queued, not blacklisted)', classifyFailure(DEFERRED), 'transient');
check('absent peer -> privacy (permanent)', classifyFailure(ABSENT), 'privacy');
check('invalid number still wins over privacy', classifyFailure('phone number invalid (permanent)'), 'invalid');
check('worker crash still transient', classifyFailure('lease expired'), 'transient');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
