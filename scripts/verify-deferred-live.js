/**
 * READ-ONLY. Confirms in production that deferred imports since the fix are
 * re-queued as transient and are NOT writing privacy suppressions.
 * Usage: node scripts/verify-deferred-live.js
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

// Worker restarted with the fix at ~12:04 local (05:04Z).
const SINCE = new Date('2026-08-01T05:00:00Z');

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  const prop = db.collection('outreach_proposals');
  const sup = db.collection('outreach_suppressions');

  const deferred = await prop.find({ failed_reason: /deferred by Telegram/i }).toArray();
  console.log(`proposals carrying the new deferred reason: ${deferred.length}`);

  const requeued = await prop.find({ org_id: 'company', transient_retries: { $gt: 0 } })
    .project({ customer_phone: 1, status: 1, transient_retries: 1, failed_reason: 1 }).toArray();
  console.log(`\nproposals re-queued at least once: ${requeued.length}`);
  requeued.slice(0, 15).forEach((r) => console.log(
    `  ${String(r.customer_phone).padEnd(15)} status=${String(r.status).padEnd(9)} retries=${r.transient_retries}`));

  const newPrivacy = await sup.countDocuments({ failure_kind: 'privacy', last_failed_at: { $gte: SINCE } });
  console.log(`\nNEW privacy suppressions since the fix went live: ${newPrivacy}  (expected 0)`);

  const newTransient = await sup.countDocuments({ failure_kind: 'transient', last_failed_at: { $gte: SINCE } });
  console.log(`new transient suppressions since the fix        : ${newTransient}  (harmless, non-blocking)`);

  const sentSince = await prop.countDocuments({ org_id: 'company', sent_at: { $gte: SINCE } });
  console.log(`messages delivered since the restart           : ${sentSince}`);

  const queue = await prop.countDocuments({ org_id: 'company', status: 'approved' });
  console.log(`still approved & waiting                       : ${queue}`);

  await client.close();
  process.exit(newPrivacy === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
