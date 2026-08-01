/**
 * Guards the three distinct outcomes of contacts.ImportContacts, which the
 * worker previously collapsed into two.
 *
 * Telegram answers an import in one of three ways:
 *   users=[u] retry=[]   -> the number resolved
 *   users=[]  retry=[id] -> import DEFERRED (throttle/quota). Says nothing about
 *                           whether the number is on Telegram. Must be transient.
 *   users=[]  retry=[]   -> genuinely absent / hidden by privacy. Permanent.
 *
 * Reading only `users` made the middle case indistinguishable from the last,
 * so a throttled import was recorded as a permanent privacy suppression and the
 * lead was blacklisted forever (169 numbers by 2026-08-01, ~68 of them wrongly).
 *
 * Run from scripts/telegram-worker:  npx ts-node check-import-outcome.ts
 */
import { Api } from 'telegram';
import bigInt from 'big-integer';
import { importPhoneAsPeer, DEFERRED_IMPORT_REASON, ABSENT_PEER_REASON } from './worker';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// Minimal stand-in for the gramjs client: invoke() returns a canned
// contacts.ImportedContacts-shaped response.
function clientReturning(resp: { users: unknown[]; retryContacts: unknown[]; imported: unknown[] }): any {
  return { invoke: async () => resp };
}

const fakeUser = Object.create(Api.User.prototype) as Api.User;
Object.assign(fakeUser, { id: bigInt(123), accessHash: bigInt(456) });

(async () => {
  const resolved = await importPhoneAsPeer(
    clientReturning({ users: [fakeUser], retryContacts: [], imported: [{}] }), '855123456', 'Lead');
  check('resolved import -> kind=user', resolved.kind, 'user');
  check('resolved import -> carries the user', resolved.kind === 'user' && resolved.user === fakeUser, true);

  const deferred = await importPhoneAsPeer(
    clientReturning({ users: [], retryContacts: [bigInt(0)], imported: [] }), '855123456', 'Lead');
  check('retryContacts non-empty -> kind=deferred', deferred.kind, 'deferred');

  const absent = await importPhoneAsPeer(
    clientReturning({ users: [], retryContacts: [], imported: [] }), '855123456', 'Lead');
  check('empty users AND empty retry -> kind=absent', absent.kind, 'absent');

  // A deferred import must never be worded so that the server's classifyFailure
  // privacy regex (/not on telegram|hidden by privacy|.../) catches it — that
  // regex is what makes a suppression permanent.
  const privacyRe = /not on telegram|hidden by privacy|phone_not_occupied|user_not_found|peer_id_invalid/;
  check('deferred reason does NOT trip the privacy regex',
    privacyRe.test(DEFERRED_IMPORT_REASON.toLowerCase()), false);
  check('absent reason DOES trip the privacy regex (stays permanent)',
    privacyRe.test(ABSENT_PEER_REASON.toLowerCase()), true);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
