/**
 * READ-ONLY. Of the numbers eligible for tomorrow's generation, how many have
 * already failed before? Privacy/invalid suppressions ALREADY block a number
 * permanently; transient ones do not, so those return and spend lookups again.
 * Usage: node scripts/query-whats-coming-back.js
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  const sup = db.collection('outreach_suppressions');

  const rows = await sup.aggregate([
    { $match: { org_id: 'company' } },
    { $group: { _id: { k: '$failure_kind', s: '$status' }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]).toArray();
  console.log('=== suppressions: kind x status ===');
  rows.forEach((r) => {
    const blocking = ['privacy', 'invalid'].includes(r._id.k) && ['active', 'exhausted'].includes(r._id.s);
    console.log(`  ${String(r._id.k).padEnd(10)} ${String(r._id.s).padEnd(10)} ${String(r.n).padStart(4)}   ${blocking ? 'BLOCKS generation' : 'returns to pool'}`);
  });

  const DatabaseConnection = require('../dist/database/connection').default;
  await DatabaseConnection.getInstance().connect();
  const { OutreachSuppressionRepository } = require('../dist/outreach/outreach-suppression-repository');
  const blocked = await new OutreachSuppressionRepository().getSuppressedPhones('company');

  const pool = (await db.collection('leads_events').distinct('customer.phone')).filter(Boolean);
  const eligible = pool.filter((p) => !blocked.has(p));

  // Of the eligible numbers, which already have a failed proposal in history?
  const everFailed = new Set(await db.collection('outreach_proposals')
    .distinct('customer_phone', { org_id: 'company', status: 'failed' }));
  const repeats = eligible.filter((p) => everFailed.has(p));

  console.log(`\npool                                : ${pool.length}`);
  console.log(`blocked from generation             : ${blocked.size}`);
  console.log(`eligible for tomorrow               : ${eligible.length}`);
  console.log(`  of those, ALREADY failed before   : ${repeats.length}   <- these come back and spend lookups again`);
  console.log(`  never attempted                   : ${eligible.length - repeats.length}`);
  console.log(`\ndaily lookup budget (DEFAULT_ATTEMPT_CAP): 40`);

  await client.close();
  await DatabaseConnection.getInstance().disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
