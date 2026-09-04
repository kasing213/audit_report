/**
 * Count distinct customers (by phone) whose most recent lead event is
 * >= N days old — i.e. the people sitting at the outreach "stale" threshold.
 * Mirrors buildStaleCustomersPipeline (src/database/aggregations.ts).
 *
 * Usage:  node scripts/count-stale-45.js [days]   (default 45)
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const days = Number(process.argv[2]) || 45;
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error('DATABASE_URL not set');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const coll = client.db().collection('leads_events');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  // distinct customers (by phone) with their last event date
  const customers = await coll.aggregate([
    { $match: { 'customer.phone': { $ne: null }, deleted: { $ne: true } } },
    { $group: {
        _id: '$customer.phone',
        last_update_date: { $max: '$date' },
        name: { $last: '$customer.name' },
        follower: { $last: '$follower' },
      } },
  ]).toArray();

  const stale = customers.filter((c) => c.last_update_date && c.last_update_date <= cutoffStr);

  console.log(`Today: ${today}`);
  console.log(`Cutoff (>= ${days} days old): last_update_date <= ${cutoffStr}`);
  console.log('');
  console.log(`Distinct customers (with phone, not deleted): ${customers.length}`);
  console.log(`STALE at >= ${days} days: ${stale.length}`);
  console.log('');

  // Bucket everyone by age so we can see the shape around the threshold
  const buckets = { '<30': 0, '30-44': 0, '45-59': 0, '60-89': 0, '90+': 0, 'no-date': 0 };
  for (const c of customers) {
    if (!c.last_update_date) { buckets['no-date']++; continue; }
    const ageDays = Math.floor((Date.now() - new Date(c.last_update_date).getTime()) / 86400000);
    if (ageDays < 30) buckets['<30']++;
    else if (ageDays < 45) buckets['30-44']++;
    else if (ageDays < 60) buckets['45-59']++;
    else if (ageDays < 90) buckets['60-89']++;
    else buckets['90+']++;
  }
  console.log('Age distribution (days since last event):');
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(8)} ${v}`);

  console.log('\nBy follower (stale >= ' + days + ' days):');
  const byFollower = {};
  for (const c of stale) {
    const f = c.follower || '(none)';
    byFollower[f] = (byFollower[f] || 0) + 1;
  }
  for (const [f, n] of Object.entries(byFollower).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(f).padEnd(20)} ${n}`);
  }

  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
