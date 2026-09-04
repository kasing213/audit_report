// DESTRUCTIVE: deletes the two auto-approved test outreach proposals for
// +85570597666 and +85586226225 so the worker doesn't ship them on startup.
// Two-step usage:
//   railway run node scripts/delete-test-proposals.js              # dry-run
//   railway run node scripts/delete-test-proposals.js --confirm    # actually deletes

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

  const target = { customer_phone: { $in: TEST_PHONES }, status: { $in: ['pending', 'approved', 'in_flight'] } };
  const rows = await db.collection('outreach_proposals').find(target)
    .project({ _id: 1, customer_phone: 1, status: 1, customer_name: 1, approved_by: 1 })
    .toArray();

  console.log(`Matched ${rows.length} proposal(s):`);
  console.log(JSON.stringify(rows, null, 2));

  if (!confirm) {
    console.log('\nDRY RUN — no changes made.');
    console.log('Re-run with --confirm to delete:');
    console.log('  railway run node scripts/delete-test-proposals.js --confirm');
    await client.close();
    return;
  }

  const result = await db.collection('outreach_proposals').deleteMany(target);
  console.log(`\nDeleted: ${result.deletedCount}`);
  const remaining = await db.collection('outreach_proposals').countDocuments(target);
  console.log(`Remaining matching: ${remaining}`);

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
