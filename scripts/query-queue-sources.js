/**
 * READ-ONLY. For everything currently queued or recently attempted: did the
 * phone come from the QuickBook/spreadsheet import (source.model='csv-import')
 * or from somewhere else?
 * Usage: node scripts/query-queue-sources.js
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();

  // Every source that ever supplied each phone.
  const srcByPhone = new Map();
  await db.collection('leads_events').aggregate([
    { $match: { 'customer.phone': { $ne: null } } },
    { $group: { _id: '$customer.phone', models: { $addToSet: '$source.model' } } },
  ]).forEach((r) => srcByPhone.set(r._id, r.models));

  const label = (phone) => {
    const m = srcByPhone.get(phone) || [];
    if (!m.length) return 'UNKNOWN';
    return m.includes('csv-import') ? `QUICKBOOK${m.length > 1 ? ' (+' + m.filter(x => x !== 'csv-import').join(',') + ')' : ''}` : `NOT-QUICKBOOK [${m.join(',')}]`;
  };

  for (const status of ['approved', 'pending']) {
    const rows = await db.collection('outreach_proposals')
      .find({ org_id: 'company', status }).sort({ approved_at: 1 }).toArray();
    console.log(`\n=== ${status} (${rows.length}) ===`);
    rows.forEach((r) => console.log(
      `  ${String(r.customer_phone).padEnd(15)} ${String(r.customer_name || '-').slice(0, 20).padEnd(20)} ${label(r.customer_phone)}`));
    const bad = rows.filter((r) => !label(r.customer_phone).startsWith('QUICKBOOK'));
    console.log(`  -> not from QuickBook: ${bad.length} of ${rows.length}`);
  }

  // Everything attempted today.
  const today = await db.collection('outreach_proposals')
    .find({ org_id: 'company', created_at: { $gte: new Date('2026-08-01T00:00:00Z') } }).toArray();
  const counts = {};
  today.forEach((r) => { const k = label(r.customer_phone).split(' ')[0]; counts[k] = (counts[k] || 0) + 1; });
  console.log('\n=== everything proposed today, by source ===');
  Object.entries(counts).forEach(([k, v]) => console.log(`  ${k.padEnd(16)} ${v}`));

  // All time.
  const all = await db.collection('outreach_proposals').distinct('customer_phone', { org_id: 'company' });
  const allCounts = {};
  all.forEach((p) => { const k = label(p).split(' ')[0]; allCounts[k] = (allCounts[k] || 0) + 1; });
  console.log('\n=== all phones ever proposed, by source ===');
  Object.entries(allCounts).forEach(([k, v]) => console.log(`  ${k.padEnd(16)} ${v}`));

  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
