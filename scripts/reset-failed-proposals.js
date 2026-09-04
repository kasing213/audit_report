// Re-arm outreach proposals that failed because the worker could not resolve
// the phone number to a Telegram entity ("Cannot find any entity …"). That
// failure mode is fixed by the ImportContacts change in the worker, so these
// are worth retrying. Flips status failed → approved and clears the failure
// bookkeeping so claimNextApproved() will pick them up again.
//
// Two-step (safe by default):
//   node scripts/reset-failed-proposals.js              # dry-run, shows matches
//   node scripts/reset-failed-proposals.js --confirm    # actually update
//
// DATABASE_URL is read from the repo-root .env (falls back to the ambient env,
// so `railway run node scripts/reset-failed-proposals.js` also works).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

// The exact gramjs message for an unresolvable phone; anchored so we only
// re-arm this specific, now-fixed failure mode and not genuine dead numbers.
const ENTITY_ERROR = /Cannot find any entity corresponding to/i;

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set (checked .env and ambient env).');
    process.exit(1);
  }
  const confirm = process.argv.includes('--confirm');
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();
  console.log('DB:', db.databaseName);

  const target = { status: 'failed', failed_reason: { $regex: ENTITY_ERROR } };
  const rows = await db.collection('outreach_proposals').find(target)
    .project({ _id: 1, customer_phone: 1, customer_name: 1, status: 1, failed_reason: 1, approved_at: 1 })
    .toArray();

  console.log(`\nMatched ${rows.length} failed row(s) with the entity-resolution error:`);
  for (const r of rows) {
    console.log(`  ${r._id}  ${r.customer_phone}  ${r.customer_name || '?'}  reason="${(r.failed_reason || '').slice(0, 70)}"`);
  }

  if (rows.length === 0) {
    console.log('\nNothing matched. (Maybe already reset, or failed for other reasons.)');
    await client.close();
    return;
  }

  if (!confirm) {
    console.log('\nDRY RUN — no changes made.');
    console.log('Re-run with --confirm to flip status failed → approved:');
    console.log('  node scripts/reset-failed-proposals.js --confirm');
    await client.close();
    return;
  }

  const result = await db.collection('outreach_proposals').updateMany(target, {
    $set: { status: 'approved', failed_reason: null, lease_expires_at: null, claim_attempts: 0 }
  });
  console.log(`\nMatched: ${result.matchedCount}  Modified: ${result.modifiedCount}`);

  const after = await db.collection('outreach_proposals')
    .find({ _id: { $in: rows.map(r => r._id) } })
    .project({ _id: 1, customer_phone: 1, status: 1 })
    .toArray();
  console.log('\nPost-reset state:');
  for (const r of after) {
    console.log(`  ${r._id}  ${r.customer_phone}  status=${r.status}`);
  }

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
