require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  const prop = db.collection('outreach_proposals');

  const one = await prop.findOne({ failed_reason: /timed out/i });
  console.log('=== fields on a timeout proposal ===');
  console.log(JSON.stringify(one, null, 2));

  const all = await prop.find({ failed_reason: /timed out/i }).sort({ _id: 1 }).toArray();
  console.log('\n=== all 26, by _id timestamp (real failure ordering) ===');
  all.forEach(r => console.log(
    `${r._id.getTimestamp().toISOString().slice(0,16)}  gen=${r.generation_id}  ${String(r.customer_phone).padEnd(15)} lease=${r.lease_expires_at ? new Date(r.lease_expires_at).toISOString().slice(0,16) : '-'}`));

  console.log('\n=== timeouts per generation_id ===');
  const byGen = {};
  all.forEach(r => byGen[r.generation_id] = (byGen[r.generation_id] || 0) + 1);
  for (const [g, n] of Object.entries(byGen)) {
    const total = await prop.countDocuments({ generation_id: g });
    const sent = await prop.countDocuments({ generation_id: g, status: 'sent' });
    console.log(`${g}: ${n} timeouts / ${total} proposals (${sent} sent)`);
  }

  // Overall status mix, last 30 days
  console.log('\n=== proposal status mix (all time) ===');
  const mix = await prop.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
  mix.forEach(r => console.log(`${String(r._id).padEnd(12)} ${r.n}`));

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
