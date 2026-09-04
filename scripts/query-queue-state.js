require('dotenv').config();
const { MongoClient } = require('mongodb');
(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  const prop = db.collection('outreach_proposals');
  const start = new Date('2026-08-01T00:00:00Z');

  const mix = await prop.aggregate([
    { $match: { created_at: { $gte: start } } },
    { $group: { _id: { s: '$status', o: '$org_id' }, n: { $sum: 1 } } }, { $sort: { n: -1 } },
  ]).toArray();
  console.log('=== today\'s proposals by status/org ===');
  mix.forEach(r => console.log(`${String(r._id.s).padEnd(10)} ${String(r._id.o).padEnd(10)} ${r.n}`));

  const claimable = await prop.countDocuments({ status: 'approved', org_id: 'company' });
  console.log(`\napproved & claimable (company, all dates): ${claimable}`);

  const recent = await prop.find({ org_id: 'company', status: 'failed' })
    .sort({ _id: -1 }).limit(8).project({ customer_phone: 1, failed_reason: 1, transient_retries: 1 }).toArray();
  console.log('\n=== 8 most recent failures ===');
  recent.forEach(r => console.log(`${String(r.customer_phone).padEnd(15)} retries=${r.transient_retries ?? 0} :: ${r.failed_reason}`));
  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
