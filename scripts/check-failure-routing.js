require('./check-db').useScratchDb();

/**
 * Verifies failure routing: privacy/invalid are permanently closed (no retry
 * clock), a transient failure re-queues the proposal at most 3 times, a stray
 * transient/deferred failure never defeats an active contact-cooldown (Task
 * 3's clock guard in recordFailure), and the 'deferred' kind (2026-08-01
 * outreach-failure-taxonomy spec) parks a phone on a temporary
 * DEFERRED_COOLDOWN_DAYS clock instead of a permanent one.
 *
 * Usage: node scripts/check-failure-routing.js
 *
 * Runs against a scratch database (Audit_check on the same cluster), never
 * production `Audit` — see scripts/check-db.js.
 */
const { MongoClient, ObjectId } = require('mongodb');

const PHONE = '+855999000222';
const PHONE_COOLDOWN = '+855999000444';
const PHONE_DEFERRED = '+855999000666';
const DAY_MS = 24 * 60 * 60 * 1000;

// Kept in sync with DEFERRED_IMPORT_REASON in scripts/telegram-worker/worker.ts
// (that file is ts-node-only, not part of the tsc build this harness requires
// from dist/, so the literal is duplicated here — same convention as
// scripts/check-deferred-import-routing.js).
const DEFERRED_IMPORT_REASON = 'contact import deferred by Telegram (retry later)';
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
  const { OutreachSuppressionRepository, classifyFailure, deferredCooldownDays } =
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

  // --- Deferred failure taxonomy (2026-08-01 spec: outreach failure taxonomy
  // + QuickBook-only targeting). 'deferred' covers a Telegram-refused import
  // or a timed-out send: real signal about the number, but not proof it's
  // dead, so it gets a temporary park instead of privacy/invalid's permanent one.
  check('classifyFailure(DEFERRED_IMPORT_REASON) -> deferred',
    classifyFailure(DEFERRED_IMPORT_REASON), 'deferred');
  check('send-timeout exception classifies as deferred',
    classifyFailure('exception: send timed out after 240s'), 'deferred');
  check('lease-expired (unrecognised) reason still falls through to transient',
    classifyFailure('lease expired without resolution (3rd attempt)'), 'transient');

  await db.collection('outreach_suppressions').deleteMany({ customer_phone: PHONE_DEFERRED });
  await suppRepo.recordFailure({ phone: PHONE_DEFERRED, reason: DEFERRED_IMPORT_REASON, orgId: 'company' });
  const deferredDoc = await db.collection('outreach_suppressions').findOne({ customer_phone: PHONE_DEFERRED, org_id: 'company' });
  check('deferred failure: failure_kind is deferred', deferredDoc && deferredDoc.failure_kind, 'deferred');
  const expectedEligible = deferredDoc && new Date(deferredDoc.last_failed_at.getTime() + deferredCooldownDays() * DAY_MS);
  const eligibleWithinTolerance = Boolean(
    deferredDoc && deferredDoc.eligible_again_at &&
    Math.abs(deferredDoc.eligible_again_at.getTime() - expectedEligible.getTime()) < 5000
  );
  check('deferred failure: eligible_again_at ~= now + DEFERRED_COOLDOWN_DAYS', eligibleWithinTolerance, true);
  check('deferred failure: next_retry_at is NOT null (not a permanent park)',
    Boolean(deferredDoc && deferredDoc.next_retry_at !== null), true);

  check('deferred failure: phone excluded from pool while inside the window',
    (await suppRepo.getSuppressedPhones('company')).has(PHONE_DEFERRED), true);

  // Simulate the cooldown elapsing.
  await db.collection('outreach_suppressions').updateOne(
    { customer_phone: PHONE_DEFERRED, org_id: 'company' },
    { $set: { eligible_again_at: new Date(Date.now() - DAY_MS) } }
  );
  check('deferred failure: phone included again once eligible_again_at has passed',
    (await suppRepo.getSuppressedPhones('company')).has(PHONE_DEFERRED), false);

  // A transient failure (our own outage) sets no eligible_again_at — pm2
  // downtime must never park a customer, even temporarily.
  await db.collection('outreach_suppressions').deleteMany({ customer_phone: PHONE_DEFERRED });
  await suppRepo.recordFailure({ phone: PHONE_DEFERRED, reason: 'lease expired', orgId: 'company' });
  const transientDoc = await db.collection('outreach_suppressions').findOne({ customer_phone: PHONE_DEFERRED, org_id: 'company' });
  check('transient failure: failure_kind is transient', transientDoc && transientDoc.failure_kind, 'transient');
  check('transient failure: sets no eligible_again_at', Boolean(transientDoc && transientDoc.eligible_again_at), false);

  // Amendment: an active 'contacted' cooldown must also survive a stray
  // 'deferred' failure, not just a stray 'transient' one (same clock guard).
  await db.collection('outreach_suppressions').deleteMany({ customer_phone: PHONE_DEFERRED });
  await suppRepo.recordContacted({ phone: PHONE_DEFERRED, orgId: 'company' });
  await suppRepo.recordFailure({ phone: PHONE_DEFERRED, reason: DEFERRED_IMPORT_REASON, orgId: 'company' });
  const survivedDoc = await db.collection('outreach_suppressions').findOne({ customer_phone: PHONE_DEFERRED, org_id: 'company' });
  check('active cooldown survives a stray deferred failure: kind still contacted',
    survivedDoc && survivedDoc.failure_kind, 'contacted');

  await db.collection('outreach_suppressions').deleteMany({ customer_phone: { $in: [PHONE, PHONE_COOLDOWN, PHONE_DEFERRED] } });
  await db.collection('outreach_proposals').deleteMany({ customer_phone: PHONE });
  await client.close();
  await DatabaseConnection.getInstance().disconnect();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
