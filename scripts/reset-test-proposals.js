// Re-arm the two test-phone outreach proposals: status sent → approved,
// clear sent_at / lease_expires_at so the worker can claim them again.
//
// Two-step:
//   railway run node scripts/reset-test-proposals.js              # dry-run
//   railway run node scripts/reset-test-proposals.js --confirm    # actually update

const { MongoClient } = require('mongodb');

const TEST_PHONES = ['+85570597666', '+85586226225'];

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set; run via `railway run …`');
    process.exit(1);
  }
  const confirm = process.argv.includes('--confirm');
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();
  console.log('DB:', db.databaseName);

  const target = { customer_phone: { $in: TEST_PHONES }, status: 'sent' };
  const rows = await db.collection('outreach_proposals').find(target)
    .project({ _id: 1, customer_phone: 1, status: 1, sent_at: 1, approved_at: 1, message: 1 })
    .toArray();

  console.log(`\nMatched ${rows.length} sent row(s) for test phones:`);
  for (const r of rows) {
    console.log(`  ${r._id}  ${r.customer_phone}  sent_at=${r.sent_at}  msg="${(r.message || '').slice(0, 60)}…"`);
  }

  if (rows.length === 0) {
    console.log('\nNothing matched. (Maybe already reset, or sent rows were deleted.)');
    await client.close();
    return;
  }

  if (!confirm) {
    console.log('\nDRY RUN — no changes made.');
    console.log('Re-run with --confirm to flip status sent → approved:');
    console.log('  railway run node scripts/reset-test-proposals.js --confirm');
    await client.close();
    return;
  }

  const result = await db.collection('outreach_proposals').updateMany(target, {
    $set: { status: 'approved', sent_at: null, lease_expires_at: null, claim_attempts: 0 }
  });
  console.log(`\nMatched: ${result.matchedCount}  Modified: ${result.modifiedCount}`);

  const after = await db.collection('outreach_proposals')
    .find({ customer_phone: { $in: TEST_PHONES } })
    .project({ _id: 1, customer_phone: 1, status: 1, sent_at: 1 })
    .toArray();
  console.log('\nPost-reset state:');
  for (const r of after) {
    console.log(`  ${r._id}  ${r.customer_phone}  status=${r.status}  sent_at=${r.sent_at}`);
  }

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
