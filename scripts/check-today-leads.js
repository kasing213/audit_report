/**
 * Diagnostic: count leads_events grouped by date for the last 14 days,
 * and list distinct date string formats found.
 *
 * Usage:  node scripts/check-today-leads.js
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error('DATABASE_URL not set');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  const coll = db.collection('leads_events');

  const total = await coll.countDocuments({});
  console.log(`Total leads_events: ${total}`);

  const byDate = await coll
    .aggregate([
      { $group: { _id: '$date', n: { $sum: 1 } } },
      { $sort: { _id: -1 } },
      { $limit: 30 },
    ])
    .toArray();

  console.log('\nLast 30 distinct date values (newest first):');
  for (const row of byDate) {
    console.log(`  ${JSON.stringify(row._id)}  ->  ${row.n}`);
  }

  const today = new Date().toISOString().split('T')[0];
  console.log(`\nProcess "today" = ${today}`);
  const todayDocs = await coll.find({ date: today }).limit(50).toArray();
  console.log(`Docs with date == "${today}": ${todayDocs.length}`);
  for (const d of todayDocs.slice(0, 5)) {
    console.log('  sample:', {
      _id: d._id,
      date: d.date,
      customer: d.customer,
      page: d.page,
      follower: d.follower,
      status_text: d.status_text,
      created_at: d.created_at,
      deleted: d.deleted,
    });
  }

  console.log('\nMost recent 5 docs by created_at:');
  const recent = await coll.find({}).sort({ created_at: -1 }).limit(5).toArray();
  for (const d of recent) {
    console.log('  ', {
      _id: d._id,
      date: d.date,
      created_at: d.created_at,
      customer: d.customer && d.customer.phone,
      follower: d.follower,
      deleted: d.deleted,
    });
  }

  await client.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
