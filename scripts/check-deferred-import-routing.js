/**
 * The worker's deferred-import reason must classify as 'deferred' — a
 * temporary DEFERRED_COOLDOWN_DAYS park, never a 'transient' free pass (that
 * would let the same throttled number get re-picked immediately, see the
 * back-of-queue fix in check-failure-routing.js) and never a 'privacy'
 * permanent blacklist (next_retry_at=null forever) either. Updated for the
 * 2026-08-01 outreach-failure-taxonomy spec, which split 'deferred' out of
 * what this reason used to classify as ('transient'). Pure function check —
 * no database.
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

check('deferred import -> deferred (temporary park, not blacklisted, not a free pass)', classifyFailure(DEFERRED), 'deferred');
check('absent peer -> privacy (permanent)', classifyFailure(ABSENT), 'privacy');
check('invalid number still wins over privacy', classifyFailure('phone number invalid (permanent)'), 'invalid');
check('worker crash still transient', classifyFailure('lease expired'), 'transient');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
