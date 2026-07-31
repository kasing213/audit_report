require('./check-db').useScratchDb();

/**
 * Verifies the 180-day contact cooldown: recordContacted writes an expiry,
 * an in-cooldown number is suppressed, an expired one is not, and the rule
 * is scoped per workspace. Also verifies the clock-guard in recordFailure
 * (an active cooldown survives a stray failure; an expired one doesn't block
 * a genuine new failure) and that recordContacted dedupes against legacy
 * (org_id: null) docs instead of inserting a second document.
 *
 * Usage: node scripts/check-contact-cooldown.js
 *
 * Runs against a scratch database (Audit_check on the same cluster), never
 * production `Audit` — see scripts/check-db.js.
 */
const { MongoClient } = require('mongodb');

const PHONE = '+855999000111';
const PHONE_LEGACY = '+855999000222';
let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (got ${actual}, want ${expected})`);
}

(async () => {
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error('DATABASE_URL not set');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  console.log(`Connected to database: ${db.databaseName}`);
  if (db.databaseName !== 'Audit_check') {
    console.error(`REFUSING to run: expected scratch database "Audit_check", got "${db.databaseName}"`);
    await client.close();
    process.exit(1);
  }
  const col = db.collection('outreach_suppressions');
  await col.deleteMany({ customer_phone: { $in: [PHONE, PHONE_LEGACY] } });

  const DatabaseConnection = require('../dist/database/connection').default;
  await DatabaseConnection.getInstance().connect();
  const { OutreachSuppressionRepository, CONTACT_COOLDOWN_DAYS } =
    require('../dist/outreach/outreach-suppression-repository');
  const repo = new OutreachSuppressionRepository();

  check('cooldown constant is 180', CONTACT_COOLDOWN_DAYS, 180);

  // Fresh contact → suppressed in company, not in personal.
  await repo.recordContacted({ phone: PHONE, orgId: 'company' });
  const doc = await col.findOne({ customer_phone: PHONE, org_id: 'company' });
  check('kind is contacted', doc.failure_kind, 'contacted');
  check('next_retry_at is null', doc.next_retry_at, null);
  const days = Math.round((new Date(doc.eligible_again_at) - new Date(doc.contacted_at)) / 86400000);
  check('eligible_again_at is +180d from contacted_at', days, 180);

  const compSet = await repo.getSuppressedPhones('company');
  const persSet = await repo.getSuppressedPhones('personal');
  check('in cooldown → suppressed in company', compSet.has(PHONE), true);
  check('cooldown is per workspace', persSet.has(PHONE), false);

  // --- Clock guard, half 1: an ACTIVE cooldown must survive a stray failure. ---
  // The phone from above still has ~180d left on its cooldown. A failure
  // recorded against it now (e.g. from a manual/explicit-phones generate path
  // that bypassed getSuppressedPhones) must not cancel the cooldown.
  const eligibleBeforeFailure = doc.eligible_again_at.getTime();
  await repo.recordFailure({ phone: PHONE, reason: 'timeout contacting worker', orgId: 'company' });
  const afterStrayFailure = await col.findOne({ customer_phone: PHONE, org_id: 'company' });
  check('active cooldown survives stray failure: kind still contacted', afterStrayFailure.failure_kind, 'contacted');
  check(
    'active cooldown survives stray failure: eligible_again_at unchanged',
    new Date(afterStrayFailure.eligible_again_at).getTime(),
    eligibleBeforeFailure
  );
  const suppressedAfterStrayFailure = await repo.getSuppressedPhones('company');
  check('active cooldown survives stray failure: still suppressed', suppressedAfterStrayFailure.has(PHONE), true);

  // Expired cooldown → no longer suppressed.
  await col.updateOne(
    { customer_phone: PHONE, org_id: 'company' },
    { $set: { eligible_again_at: new Date(Date.now() - 86400000) } }
  );
  const afterExpiry = await repo.getSuppressedPhones('company');
  check('expired cooldown → eligible again', afterExpiry.has(PHONE), false);

  // --- Clock guard, half 2: an EXPIRED cooldown must not block a genuine new failure. ---
  await repo.recordFailure({ phone: PHONE, reason: 'hidden by privacy', orgId: 'company' });
  const afterExpiredFailure = await col.findOne({ customer_phone: PHONE, org_id: 'company' });
  check('expired cooldown lets new failure through: kind becomes privacy', afterExpiredFailure.failure_kind, 'privacy');
  const permSet = await repo.getSuppressedPhones('company');
  check('expired cooldown lets new failure through: now permanently suppressed', permSet.has(PHONE), true);

  // A privacy record is still permanently suppressed regardless of cooldown
  // (belt-and-braces: force eligible_again_at null and re-check).
  await col.updateOne(
    { customer_phone: PHONE, org_id: 'company' },
    { $set: { failure_kind: 'privacy', status: 'active', eligible_again_at: null } }
  );
  const privacySet = await repo.getSuppressedPhones('company');
  check('privacy still permanently suppressed', privacySet.has(PHONE), true);

  // --- recordContacted dedupes against a legacy (org_id: null) doc instead of
  // inserting a second document, so a delivered send actually clears an old
  // permanent privacy suppression written before multi-org existed. ---
  await col.insertOne({
    org_id: null,
    customer_phone: PHONE_LEGACY,
    failure_kind: 'privacy',
    status: 'active',
    first_failed_at: new Date(),
    last_failed_at: new Date(),
    last_failed_reason: 'legacy pre-multi-org privacy failure',
    retries_used: 0,
    next_retry_at: null,
    last_proposal_id: null,
    customer_name: null,
    follower: null,
    created_at: new Date(),
    updated_at: new Date(),
    resolved_at: null,
  });
  await repo.recordContacted({ phone: PHONE_LEGACY, orgId: 'company' });
  const legacyDocs = await col.find({ customer_phone: PHONE_LEGACY }).toArray();
  // The legacy doc is matched (not duplicated) via orgMatch, same as every other
  // reader/writer in this file — consistent with resolve()/recordFailure(), its
  // org_id is left as null (still correctly matched by orgMatch('company') on
  // every future read) rather than being rewritten in place.
  check('recordContacted dedupes legacy doc: exactly one document', legacyDocs.length, 1);
  check('recordContacted dedupes legacy doc: kind is contacted', legacyDocs[0] && legacyDocs[0].failure_kind, 'contacted');

  // Insert path (brand-new phone, no existing doc of any org_id): the upsert's
  // $setOnInsert must still pin a concrete org_id, not leave it absent/null.
  const PHONE_FRESH = '+855999000333';
  await col.deleteMany({ customer_phone: PHONE_FRESH });
  await repo.recordContacted({ phone: PHONE_FRESH, orgId: 'company' });
  const freshDocs = await col.find({ customer_phone: PHONE_FRESH }).toArray();
  check('recordContacted insert path: exactly one document', freshDocs.length, 1);
  check('recordContacted insert path: org_id is concrete company', freshDocs[0] && freshDocs[0].org_id, 'company');
  await col.deleteMany({ customer_phone: PHONE_FRESH });
  const legacySuppressedCompany = await repo.getSuppressedPhones('company');
  const legacySuppressedPersonal = await repo.getSuppressedPhones('personal');
  check('recordContacted dedupes legacy doc: suppressed in company (cooldown)', legacySuppressedCompany.has(PHONE_LEGACY), true);
  check('recordContacted dedupes legacy doc: not suppressed in personal', legacySuppressedPersonal.has(PHONE_LEGACY), false);

  await col.deleteMany({ customer_phone: { $in: [PHONE, PHONE_LEGACY] } });
  await client.close();
  await DatabaseConnection.getInstance().disconnect();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
