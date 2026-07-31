/**
 * Verifies the WRITE path of scripts/backfill-contacted-ledger.js against a
 * scratch database (Audit_check on the same cluster), never production
 * `Audit`. The backfill script itself is run completely unmodified, as a
 * separate child process, with DATABASE_URL overridden to the scratch
 * connection string for that child process only — the backfill script's own
 * production default (reading DATABASE_URL from the real environment) is
 * never touched.
 *
 * Seeds outreach_proposals with 'sent' proposals (some inside the 180d
 * cooldown window, some past it, one legacy doc with no org_id, one with no
 * sent_at at all, one 'pending' proposal that must be ignored) plus a
 * pre-existing 'privacy' suppression carrying a retry clock. Runs the
 * backfill twice with --confirm and asserts:
 *   - a 'contacted' suppression exists per distinct (org, phone) with
 *     eligible_again_at === sent_at + 180d, latest send wins;
 *   - sends older than 180 days produce already-expired records (phone stays
 *     eligible) — this is a clock install, not a mass closure;
 *   - the privacy record's next_retry_at is now null;
 *   - the backfill is idempotent (second run produces no duplicates, no
 *     change in state).
 *
 * Usage: node scripts/check-backfill-contacted-ledger.js
 */
const { useScratchDb } = require('./check-db');
const scratchUrl = useScratchDb();

const path = require('path');
const { execFileSync } = require('child_process');
const { MongoClient } = require('mongodb');

const DAY_MS = 24 * 60 * 60 * 1000;
// Frozen once so seed-time and check-time computations of the same "N days
// ago" instant agree to the millisecond (independent Date.now() calls a few
// seconds apart would otherwise produce spurious mismatches).
const NOW = new Date();
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY_MS);

const PHONE_RECENT = '+855977000001'; // sent 30d ago -> still in cooldown; also has an older send that must lose
const PHONE_OLD = '+855977000002'; // sent 300d ago -> cooldown already expired
const PHONE_PERSONAL = '+855977000003'; // personal org, sent 10d ago -> must not leak into company
const PHONE_LEGACY = '+855977000004'; // no org_id, no sent_at -> attributed to company, falls back to created_at
const PHONE_NOT_SENT = '+855977000099'; // status 'pending' -> must be ignored entirely
const PHONE_PRIVACY = '+855977000005'; // pre-existing privacy suppression with a retry clock

const ALL_PHONES = [PHONE_RECENT, PHONE_OLD, PHONE_PERSONAL, PHONE_LEGACY, PHONE_NOT_SENT, PHONE_PRIVACY];

let failures = 0;
function check(label, actual, expected) {
  const a = actual instanceof Date ? actual.getTime() : actual;
  const e = expected instanceof Date ? expected.getTime() : expected;
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (got ${a}, want ${e})`);
}

function baseProposal(overrides) {
  return {
    generation_id: 'chk',
    customer_name: null,
    reason_code: null,
    days_since_contact: null,
    follower: null,
    message: 'x',
    reasoning: 'x',
    skipped_reason: null,
    failed_reason: null,
    custom_image_id: null,
    approved_at: null,
    approved_by: null,
    lease_expires_at: null,
    model: 'x',
    ...overrides,
  };
}

(async () => {
  const client = new MongoClient(scratchUrl, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  console.log(`Connected to database: ${db.databaseName}`);
  if (db.databaseName !== 'Audit_check') {
    console.error(`REFUSING to run: expected scratch database "Audit_check", got "${db.databaseName}"`);
    await client.close();
    process.exit(1);
  }

  const proposals = db.collection('outreach_proposals');
  const suppressions = db.collection('outreach_suppressions');

  // Clean slate.
  await proposals.deleteMany({ customer_phone: { $in: ALL_PHONES } });
  await suppressions.deleteMany({ customer_phone: { $in: ALL_PHONES } });

  // --- Seed proposals ---

  // PHONE_RECENT: two sends, latest (30d ago) must win over the older (60d ago).
  await proposals.insertOne(baseProposal({
    org_id: 'company', customer_phone: PHONE_RECENT, customer_name: 'Recent Older Send',
    follower: 'OldFollower', status: 'sent', sent_at: daysAgo(60), created_at: daysAgo(61),
  }));
  await proposals.insertOne(baseProposal({
    org_id: 'company', customer_phone: PHONE_RECENT, customer_name: 'Recent Co',
    follower: 'Alice', status: 'sent', sent_at: daysAgo(30), created_at: daysAgo(31),
  }));

  // PHONE_OLD: single send 300d ago -> cooldown already expired.
  await proposals.insertOne(baseProposal({
    org_id: 'company', customer_phone: PHONE_OLD, customer_name: 'Old Co',
    follower: 'Bob', status: 'sent', sent_at: daysAgo(300), created_at: daysAgo(301),
  }));

  // PHONE_PERSONAL: personal org, sent 10d ago.
  await proposals.insertOne(baseProposal({
    org_id: 'personal', customer_phone: PHONE_PERSONAL, customer_name: 'Personal Cust',
    follower: 'Carol', status: 'sent', sent_at: daysAgo(10), created_at: daysAgo(11),
  }));

  // PHONE_LEGACY: no org_id at all, no sent_at -> falls back to created_at, attributed to company.
  await proposals.insertOne(baseProposal({
    customer_phone: PHONE_LEGACY, customer_name: 'Legacy Co',
    follower: 'Dave', status: 'sent', sent_at: null, created_at: daysAgo(20),
  }));

  // PHONE_NOT_SENT: still pending -> must be ignored entirely.
  await proposals.insertOne(baseProposal({
    org_id: 'company', customer_phone: PHONE_NOT_SENT, customer_name: 'Not Sent',
    follower: 'Eve', status: 'pending', sent_at: null, created_at: daysAgo(5),
  }));

  // --- Seed a pre-existing privacy suppression with a retry clock ---
  await suppressions.insertOne({
    org_id: 'company', customer_phone: PHONE_PRIVACY, failure_kind: 'privacy', status: 'active',
    first_failed_at: daysAgo(5), last_failed_at: daysAgo(5), last_failed_reason: 'hidden by privacy',
    retries_used: 0, next_retry_at: daysAgo(-3), // non-null, in the future -> must become null
    eligible_again_at: null, contacted_at: null,
    last_proposal_id: null, customer_name: 'Privacy Cust', follower: null,
    created_at: daysAgo(5), updated_at: daysAgo(5), resolved_at: null,
  });

  const backfillPath = path.join(__dirname, 'backfill-contacted-ledger.js');
  const childEnv = { ...process.env, DATABASE_URL: scratchUrl };

  console.log('\n--- Dry run (child process, scratch DB) ---');
  const dryOut = execFileSync('node', [backfillPath], { env: childEnv, encoding: 'utf8' });
  console.log(dryOut);
  check('dry run reports scratch db', dryOut.includes('Audit_check'), true);
  check('dry run performs no writes', dryOut.includes('No writes performed'), true);
  check('dry run: no docs written for any seeded phone', await suppressions.countDocuments({ customer_phone: { $in: ALL_PHONES }, failure_kind: 'contacted' }), 0);

  console.log('\n--- First --confirm run (child process, scratch DB) ---');
  const run1 = execFileSync('node', [backfillPath, '--confirm'], { env: childEnv, encoding: 'utf8' });
  console.log(run1);

  const recentDoc = await suppressions.findOne({ customer_phone: PHONE_RECENT, org_id: 'company' });
  check('recent send: contacted doc exists (exactly one)', await suppressions.countDocuments({ customer_phone: PHONE_RECENT }), 1);
  check('recent send: failure_kind is contacted', recentDoc && recentDoc.failure_kind, 'contacted');
  check('recent send: latest sent_at wins (30d, not 60d)', recentDoc && recentDoc.contacted_at, daysAgo(30));
  // The aggregation sorts by effective sent date (desc) before $group, so
  // $first on customer_name/follower picks the LATEST send's document, not
  // an arbitrary one.
  check('recent send: customer_name from latest send', recentDoc && recentDoc.customer_name, 'Recent Co');
  check('recent send: follower from latest send', recentDoc && recentDoc.follower, 'Alice');
  check('recent send: eligible_again_at = sent_at + 180d',
    recentDoc && recentDoc.eligible_again_at,
    new Date(daysAgo(30).getTime() + 180 * DAY_MS));
  check('recent send: still inside cooldown (eligible_again_at in the future)', recentDoc && recentDoc.eligible_again_at.getTime() > Date.now(), true);
  check('recent send: next_retry_at is null', recentDoc && recentDoc.next_retry_at, null);

  const oldDoc = await suppressions.findOne({ customer_phone: PHONE_OLD, org_id: 'company' });
  check('old send: contacted doc exists', !!oldDoc, true);
  check('old send: failure_kind is contacted', oldDoc && oldDoc.failure_kind, 'contacted');
  check('old send: eligible_again_at already passed (expired -> stays eligible, not a mass closure)',
    oldDoc && oldDoc.eligible_again_at.getTime() < Date.now(), true);

  const personalDoc = await suppressions.findOne({ customer_phone: PHONE_PERSONAL, org_id: 'personal' });
  check('personal send: contacted doc exists under personal org', !!personalDoc, true);
  const personalUnderCompany = await suppressions.findOne({ customer_phone: PHONE_PERSONAL, org_id: 'company' });
  check('personal send: does not leak into company org', personalUnderCompany, null);

  const legacyDoc = await suppressions.findOne({ customer_phone: PHONE_LEGACY, org_id: 'company' });
  check('legacy no-org_id proposal: attributed to company', !!legacyDoc, true);
  check('legacy no-org_id proposal: sent_at falls back to created_at', legacyDoc && legacyDoc.contacted_at, daysAgo(20));

  const notSentDoc = await suppressions.findOne({ customer_phone: PHONE_NOT_SENT });
  check('pending (non-sent) proposal ignored: no suppression doc created', notSentDoc, null);

  const privacyDoc = await suppressions.findOne({ customer_phone: PHONE_PRIVACY });
  check('privacy record: next_retry_at cleared to null', privacyDoc && privacyDoc.next_retry_at, null);
  check('privacy record: failure_kind untouched (still privacy, not overwritten)', privacyDoc && privacyDoc.failure_kind, 'privacy');
  check('privacy record: not given an eligible_again_at', privacyDoc && privacyDoc.eligible_again_at, null);

  const contactedCountAfterRun1 = await suppressions.countDocuments({ failure_kind: 'contacted', customer_phone: { $in: ALL_PHONES } });
  const allDocsAfterRun1 = await suppressions.countDocuments({ customer_phone: { $in: ALL_PHONES } });
  check('distinct (org,phone) contacted records == distinct sends (4)', contactedCountAfterRun1, 4);

  console.log('\n--- Second --confirm run (idempotency check) ---');
  const run2 = execFileSync('node', [backfillPath, '--confirm'], { env: childEnv, encoding: 'utf8' });
  console.log(run2);

  const allDocsAfterRun2 = await suppressions.countDocuments({ customer_phone: { $in: ALL_PHONES } });
  check('idempotent: no duplicate docs after second run', allDocsAfterRun2, allDocsAfterRun1);

  const recentDoc2 = await suppressions.findOne({ customer_phone: PHONE_RECENT, org_id: 'company' });
  check('idempotent: eligible_again_at unchanged after second run', recentDoc2 && recentDoc2.eligible_again_at, recentDoc && recentDoc.eligible_again_at);
  check('idempotent: contacted_at unchanged after second run', recentDoc2 && recentDoc2.contacted_at, recentDoc && recentDoc.contacted_at);

  const privacyDoc2 = await suppressions.findOne({ customer_phone: PHONE_PRIVACY });
  check('idempotent: privacy next_retry_at still null after second run', privacyDoc2 && privacyDoc2.next_retry_at, null);

  // Cleanup.
  await proposals.deleteMany({ customer_phone: { $in: ALL_PHONES } });
  await suppressions.deleteMany({ customer_phone: { $in: ALL_PHONES } });

  await client.close();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
