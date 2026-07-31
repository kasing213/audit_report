/**
 * One-time backfill for the 180-day contact cooldown.
 *
 *   1. Every past 'sent' proposal becomes a 'contacted' suppression record with
 *      eligible_again_at = sent_at + 180d. Sends older than 180 days are written
 *      already-expired, so this installs a clock — it is NOT a mass closure.
 *   2. Every existing 'privacy' record loses its retry clock (next_retry_at=null),
 *      matching the new permanent-closure rule.
 *
 * Dry run by default. Pass --confirm to write.
 *
 * DATABASE_URL selects the target database (see scripts/check-db.js for how
 * verification scripts redirect it to a scratch database instead of touching
 * production `Audit`). This script has no scratch-specific branch of its own —
 * it always writes wherever DATABASE_URL points, so the operator's production
 * default is unchanged.
 *
 * Usage: node scripts/backfill-contacted-ledger.js [--confirm]
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');
const { CONTACT_COOLDOWN_DAYS } = require('../dist/outreach/outreach-suppression-repository');

const COOLDOWN_DAYS = CONTACT_COOLDOWN_DAYS;
const DAY_MS = 24 * 60 * 60 * 1000;

(async () => {
  const confirm = process.argv.includes('--confirm');
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  const now = new Date();

  console.log(`Connected to database: ${db.databaseName}`);
  console.log(confirm ? '=== APPLYING ===' : '=== DRY RUN (pass --confirm to write) ===');

  // 1. Contacted records from past sends. Latest send per (org, phone) wins.
  const sends = await db.collection('outreach_proposals').aggregate([
    { $match: { status: 'sent' } },
    { $group: {
      _id: { org: { $ifNull: ['$org_id', 'company'] }, phone: '$customer_phone' },
      sent_at: { $max: { $ifNull: ['$sent_at', '$created_at'] } },
      name: { $first: '$customer_name' },
      follower: { $first: '$follower' },
    } },
  ]).toArray();

  let active = 0, expired = 0;
  const ops = [];
  for (const s of sends) {
    const contactedAt = new Date(s.sent_at);
    const eligibleAgainAt = new Date(contactedAt.getTime() + COOLDOWN_DAYS * DAY_MS);
    if (eligibleAgainAt > now) active++; else expired++;
    ops.push({
      updateOne: {
        filter: { org_id: s._id.org, customer_phone: s._id.phone },
        update: {
          $set: {
            failure_kind: 'contacted',
            status: 'active',
            contacted_at: contactedAt,
            eligible_again_at: eligibleAgainAt,
            last_failed_at: contactedAt,
            last_failed_reason: `contacted — ${COOLDOWN_DAYS}d cooldown (backfilled)`,
            next_retry_at: null,
            customer_name: s.name ?? null,
            follower: s.follower ?? null,
            resolved_at: null,
            updated_at: now,
          },
          $setOnInsert: {
            first_failed_at: contactedAt,
            retries_used: 0,
            last_proposal_id: null,
            created_at: now,
          },
        },
        upsert: true,
      },
    });
  }

  console.log(`\npast sends (distinct org+phone) : ${sends.length}`);
  console.log(`  still inside 180d cooldown    : ${active}`);
  console.log(`  already past it (stay eligible): ${expired}`);

  // 2. Strip retry clocks from privacy records.
  const privacyWithClock = await db.collection('outreach_suppressions').countDocuments({
    failure_kind: 'privacy',
    next_retry_at: { $ne: null },
  });
  console.log(`privacy records with a retry clock: ${privacyWithClock} → will be cleared`);

  if (!confirm) {
    console.log('\nNo writes performed. Re-run with --confirm to apply.');
    await client.close();
    return;
  }

  if (ops.length > 0) {
    const result = await db.collection('outreach_suppressions').bulkWrite(ops, { ordered: false });
    console.log(`\ncontacted upserts: ${result.upsertedCount} inserted, ${result.modifiedCount} updated`);
  }
  const cleared = await db.collection('outreach_suppressions').updateMany(
    { failure_kind: 'privacy', next_retry_at: { $ne: null } },
    { $set: { next_retry_at: null, updated_at: now } }
  );
  console.log(`privacy retry clocks cleared: ${cleared.modifiedCount}`);
  console.log('\nDone.');
  await client.close();
})();
