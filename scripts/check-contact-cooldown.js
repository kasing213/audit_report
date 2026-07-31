require('./check-db').useScratchDb();

/**
 * Verifies the 180-day contact cooldown: recordContacted writes an expiry,
 * an in-cooldown number is suppressed, an expired one is not, and the rule
 * is scoped per workspace.
 *
 * Usage: node scripts/check-contact-cooldown.js
 *
 * Runs against a scratch database (Audit_check on the same cluster), never
 * production `Audit` — see scripts/check-db.js.
 */
const { MongoClient } = require('mongodb');

const PHONE = '+855999000111';
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
  await col.deleteMany({ customer_phone: PHONE });

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

  // Expired cooldown → no longer suppressed.
  await col.updateOne(
    { customer_phone: PHONE, org_id: 'company' },
    { $set: { eligible_again_at: new Date(Date.now() - 86400000) } }
  );
  const afterExpiry = await repo.getSuppressedPhones('company');
  check('expired cooldown → eligible again', afterExpiry.has(PHONE), false);

  // A privacy record is still permanently suppressed regardless of cooldown.
  await col.updateOne(
    { customer_phone: PHONE, org_id: 'company' },
    { $set: { failure_kind: 'privacy', status: 'active', eligible_again_at: null } }
  );
  const privacySet = await repo.getSuppressedPhones('company');
  check('privacy still permanently suppressed', privacySet.has(PHONE), true);

  await col.deleteMany({ customer_phone: PHONE });
  await client.close();
  await DatabaseConnection.getInstance().disconnect();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
