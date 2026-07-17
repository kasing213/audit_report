// Read-only snapshot of the outreach worker state + draft queue.
// Run with: railway run node scripts/check-outreach-worker.js

const { MongoClient } = require('mongodb');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set; run via `railway run node scripts/check-outreach-worker.js`');
    process.exit(1);
  }
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();
  console.log('DB:', db.databaseName);

  // worker_state is now per-org (_id: 'company' | 'personal'), not a singleton.
  const states = await db.collection('outreach_worker_state').find({}).toArray();
  const nowMs = Date.now();
  console.log('\n=== outreach_worker_state (per-org) ===');
  for (const state of states) {
    const heartbeatAgeMin =
      state?.last_heartbeat_at ? Math.round((nowMs - new Date(state.last_heartbeat_at).getTime()) / 60000) : null;
    console.log(JSON.stringify({
      org: state?._id,
      paused: state?.paused,
      worker_id: state?.worker_id,
      last_heartbeat_at: state?.last_heartbeat_at,
      heartbeat_age_minutes: heartbeatAgeMin,
      sent_today: state?.sent_today,
      claims_today: state?.claims_today,
      deliveries_today: state?.deliveries_today,
      claims_today_day: state?.claims_today_day,
      last_error: state?.last_error,
      updated_at: state?.updated_at,
    }, null, 2));
  }

  const drafts = db.collection('outreach_proposals');
  const counts = await drafts.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]).toArray();

  console.log('\n=== outreach_proposals counts by status ===');
  console.log(JSON.stringify(counts, null, 2));

  const inFlight = await drafts.find({ status: 'in_flight' })
    .project({ _id: 1, customer_phone: 1, status: 1, lease_expires_at: 1, claim_attempts: 1, approved_at: 1, created_at: 1 })
    .sort({ approved_at: 1 })
    .limit(20)
    .toArray();
  console.log('\n=== in_flight rows (oldest first, up to 20) ===');
  console.log(JSON.stringify(inFlight, null, 2));

  const approved = await drafts.find({ status: 'approved' })
    .project({ _id: 1, customer_phone: 1, approved_at: 1, approved_by: 1, created_at: 1, model: 1 })
    .sort({ approved_at: 1 })
    .limit(20)
    .toArray();
  console.log('\n=== approved rows waiting to send (oldest first, up to 20) ===');
  console.log(JSON.stringify(approved, null, 2));

  const recentFailed = await drafts.find({ status: 'failed' })
    .project({ _id: 1, customer_phone: 1, failed_reason: 1, claim_attempts: 1, approved_at: 1, sent_at: 1 })
    .sort({ approved_at: -1 })
    .limit(10)
    .toArray();
  console.log('\n=== recent failed rows (latest first, up to 10) ===');
  console.log(JSON.stringify(recentFailed, null, 2));

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
