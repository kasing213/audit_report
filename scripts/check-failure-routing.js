require('./check-db').useScratchDb();

/**
 * Verifies failure routing: privacy/invalid are permanently closed (no retry
 * clock), a transient failure re-queues the proposal at most 3 times, and a
 * stray transient failure never defeats an active contact-cooldown (Task 3's
 * clock guard in recordFailure).
 *
 * Usage: node scripts/check-failure-routing.js
 *
 * Runs against a scratch database (Audit_check on the same cluster), never
 * production `Audit` — see scripts/check-db.js.
 */
const { MongoClient, ObjectId } = require('mongodb');

const PHONE = '+855999000222';
const PHONE_COOLDOWN = '+855999000444';
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

  await db.collection('outreach_suppressions').deleteMany({ customer_phone: { $in: [PHONE, PHONE_COOLDOWN] } });
  await db.collection('outreach_proposals').deleteMany({ customer_phone: PHONE });

  const DatabaseConnection = require('../dist/database/connection').default;
  await DatabaseConnection.getInstance().connect();
  const { OutreachSuppressionRepository, classifyFailure } =
    require('../dist/outreach/outreach-suppression-repository');
  const { OutreachRepository } = require('../dist/outreach/outreach-repository');
  const suppRepo = new OutreachSuppressionRepository();
  const outreachRepo = new OutreachRepository();

  check('privacy reason classifies as privacy',
    classifyFailure('phone number not on Telegram (or hidden by privacy)'), 'privacy');
  check('crash reason classifies as transient',
    classifyFailure('lease expired'), 'transient');

  // Privacy failure is permanently closed — no retry clock.
  await suppRepo.recordFailure({
    phone: PHONE, reason: 'phone number not on Telegram (or hidden by privacy)', orgId: 'company',
  });
  const priv = await db.collection('outreach_suppressions').findOne({ customer_phone: PHONE });
  check('privacy next_retry_at is null', priv.next_retry_at, null);
  check('privacy is suppressed', (await suppRepo.getSuppressedPhones('company')).has(PHONE), true);

  // Transient re-queue is bounded at 3.
  const ins = await db.collection('outreach_proposals').insertOne({
    org_id: 'company', generation_id: 'check', customer_phone: PHONE, customer_name: null,
    reason_code: null, days_since_contact: null, follower: null, message: 'x',
    reasoning: 'check', status: 'in_flight', skipped_reason: null, failed_reason: null,
    custom_image_id: null, created_at: new Date(), approved_at: new Date(),
    approved_by: 'check', sent_at: null, lease_expires_at: null, model: 'static',
  });
  const id = String(ins.insertedId);
  for (let i = 1; i <= 3; i++) {
    check(`transient requeue #${i} succeeds`, await outreachRepo.requeueTransient(id, 3), true);
    const doc = await db.collection('outreach_proposals').findOne({ _id: new ObjectId(id) });
    check(`  status back to approved (#${i})`, doc.status, 'approved');
    check(`  transient_retries === ${i}`, doc.transient_retries, i);
    await db.collection('outreach_proposals').updateOne(
      { _id: new ObjectId(id) }, { $set: { status: 'in_flight' } });
  }
  check('4th requeue refused', await outreachRepo.requeueTransient(id, 3), false);

  // --- A re-queued proposal must go to the BACK of the queue, not the front.
  // claimNextApproved sorts by approved_at ascending, so leaving approved_at
  // untouched made the worker re-claim the number it had just failed on,
  // hammering one phone 4x in a row (observed live 2026-08-01 12:07-12:19)
  // while the rest of the queue sat idle.
  await db.collection('outreach_proposals').deleteMany({ generation_id: 'order-check' });
  const older = new Date('2026-01-01T00:00:00Z');
  const newer = new Date('2026-01-02T00:00:00Z');
  const base = {
    org_id: 'company', generation_id: 'order-check', customer_name: null, reason_code: null,
    days_since_contact: null, follower: null, message: 'x', reasoning: 'check',
    skipped_reason: null, failed_reason: null, custom_image_id: null, created_at: older,
    approved_by: 'check', sent_at: null, lease_expires_at: null, model: 'static',
  };
  const a = await db.collection('outreach_proposals').insertOne({
    ...base, customer_phone: '+855999000777', status: 'in_flight', approved_at: older });
  await db.collection('outreach_proposals').insertOne({
    ...base, customer_phone: '+855999000888', status: 'approved', approved_at: newer });

  const beforeReq = await db.collection('outreach_proposals').findOne({ _id: a.insertedId });
  await outreachRepo.requeueTransient(String(a.insertedId), 3);
  const afterReq = await db.collection('outreach_proposals').findOne({ _id: a.insertedId });
  check('requeue advances approved_at',
    afterReq.approved_at > beforeReq.approved_at, true);

  // With both approved, the next claim must be the OTHER phone.
  const claimed = await outreachRepo.claimNextApproved('company', 60000);
  check('next claim is a different phone, not the one just re-queued',
    claimed && claimed.customer_phone, '+855999000888');

  await db.collection('outreach_proposals').deleteMany({ generation_id: 'order-check' });

  // --- Amendment 3: a phone inside an ACTIVE contact cooldown must not have
  // its failure_kind flipped by a stray transient failure (Task 3's clock
  // guard in recordFailure). Seed a fresh 'contacted' record with an
  // eligible_again_at far in the future, then feed it a transient failure.
  await db.collection('outreach_suppressions').deleteMany({ customer_phone: PHONE_COOLDOWN });
  await suppRepo.recordContacted({ phone: PHONE_COOLDOWN, orgId: 'company' });
  const beforeCooldown = await db.collection('outreach_suppressions').findOne({ customer_phone: PHONE_COOLDOWN, org_id: 'company' });
  check('cooldown seed: kind is contacted', beforeCooldown.failure_kind, 'contacted');

  await suppRepo.recordFailure({ phone: PHONE_COOLDOWN, reason: 'lease expired', orgId: 'company' });
  const afterCooldown = await db.collection('outreach_suppressions').findOne({ customer_phone: PHONE_COOLDOWN, org_id: 'company' });
  check('active cooldown survives stray transient failure: kind still contacted', afterCooldown.failure_kind, 'contacted');
  check('active cooldown survives stray transient failure: still suppressed',
    (await suppRepo.getSuppressedPhones('company')).has(PHONE_COOLDOWN), true);

  await db.collection('outreach_suppressions').deleteMany({ customer_phone: { $in: [PHONE, PHONE_COOLDOWN] } });
  await db.collection('outreach_proposals').deleteMany({ customer_phone: PHONE });
  await client.close();
  await DatabaseConnection.getInstance().disconnect();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
