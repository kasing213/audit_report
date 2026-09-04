/**
 * READ-ONLY. buildQuickBookCustomersPipeline groups a customer's events by
 * phone and takes $last (most recent) for name/page/follower/etc. A customer
 * qualifies for the QuickBook list if ANY event is 'csv-import' — but the
 * values SHOWN come from their newest event, whatever its source. So a later
 * manual or outreach-worker event silently shadows the imported values.
 *
 * This reports how many QuickBook customers are currently displaying data that
 * did not come from the QuickBook import.
 *
 * Usage: node scripts/query-quickbook-shadowing.js
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();

  const rows = await db.collection('leads_events').aggregate([
    { $match: { 'customer.phone': { $ne: null }, deleted: { $ne: true } } },
    { $sort: { 'customer.phone': 1, date: 1, created_at: 1 } },
    { $group: {
      _id: '$customer.phone',
      import_models: { $addToSet: '$source.model' },
      last_model: { $last: '$source.model' },
      last_name: { $last: '$customer.name' },
      last_page: { $last: '$page' },
      last_follower: { $last: '$follower' },
      events: { $push: { m: '$source.model', name: '$customer.name', page: '$page', follower: '$follower', d: '$date' } },
      total: { $sum: 1 },
    } },
    { $match: { import_models: 'csv-import' } },
  ]).toArray();

  console.log(`QuickBook customers (>=1 csv-import event): ${rows.length}`);

  const shadowed = rows.filter((r) => r.last_model !== 'csv-import');
  console.log(`showing data from a NON-QuickBook event  : ${shadowed.length}`);

  const byModel = {};
  shadowed.forEach((r) => { byModel[r.last_model] = (byModel[r.last_model] || 0) + 1; });
  console.log('\nwhich source is overwriting the display:');
  Object.entries(byModel).forEach(([m, n]) => console.log(`  ${String(m).padEnd(18)} ${n}`));

  // Where the imported value and the displayed value actually differ, the
  // overwrite is visible to the operator rather than merely theoretical.
  let diffName = 0, diffPage = 0, diffFollower = 0;
  const examples = [];
  for (const r of shadowed) {
    const imported = [...r.events].reverse().find((e) => e.m === 'csv-import');
    if (!imported) continue;
    const dn = imported.name !== r.last_name;
    const dp = imported.page !== r.last_page;
    const df = imported.follower !== r.last_follower;
    if (dn) diffName++;
    if (dp) diffPage++;
    if (df) diffFollower++;
    if ((dn || dp || df) && examples.length < 12) {
      examples.push({ phone: r._id, imported, shown: { name: r.last_name, page: r.last_page, follower: r.last_follower }, last_model: r.last_model });
    }
  }
  console.log(`\nvalues that actually differ from the import:`);
  console.log(`  name differs     : ${diffName}`);
  console.log(`  page differs     : ${diffPage}`);
  console.log(`  follower differs : ${diffFollower}`);

  console.log('\n=== examples (QuickBook value -> what the page shows) ===');
  examples.forEach((e) => {
    console.log(`\n${e.phone}   (newest event source: ${e.last_model})`);
    console.log(`  name     : ${JSON.stringify(e.imported.name)}  ->  ${JSON.stringify(e.shown.name)}`);
    console.log(`  page     : ${JSON.stringify(e.imported.page)}  ->  ${JSON.stringify(e.shown.page)}`);
    console.log(`  follower : ${JSON.stringify(e.imported.follower)}  ->  ${JSON.stringify(e.shown.follower)}`);
  });

  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
