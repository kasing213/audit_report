// DESTRUCTIVE: hard-deletes every document in the `leads_events` collection.
// Two-step usage so you cannot wipe production by accident:
//   railway run node scripts/clear-leads-events.js              # dry-run, shows count
//   railway run node scripts/clear-leads-events.js --confirm    # actually deletes

const { MongoClient } = require('mongodb');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set; run via `railway run node scripts/clear-leads-events.js`');
    process.exit(1);
  }
  const confirm = process.argv.includes('--confirm');
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();

  console.log('DB name:', db.databaseName);
  console.log('Collection: leads_events');

  const total = await db.collection('leads_events').countDocuments({});
  console.log(`Documents currently in leads_events: ${total}`);

  if (!confirm) {
    console.log('\nDRY RUN — no changes made.');
    console.log('Re-run with --confirm to hard-delete all documents:');
    console.log('  railway run node scripts/clear-leads-events.js --confirm');
    await client.close();
    return;
  }

  console.log('\n--confirm flag detected; deleting ALL documents in leads_events...');
  const result = await db.collection('leads_events').deleteMany({});
  console.log(`Deleted: ${result.deletedCount}`);
  const remaining = await db.collection('leads_events').countDocuments({});
  console.log(`Remaining: ${remaining}`);

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
