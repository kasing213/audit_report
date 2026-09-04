/**
 * READ-ONLY. The worker log prints "(N/15 today)" from an in-memory counter
 * that resets on every restart (163 restarts on this account), and the server
 * logs "daily cap reached" from an ATTEMPT ceiling that failed lookups also
 * consume. Neither is the count of messages actually delivered.
 *
 * Usage: node scripts/query-daily-cap-truth.js
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const start = new Date('2026-08-01T00:00:00Z');
const end = new Date('2026-08-02T00:00:00Z');

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  const prop = db.collection('outreach_proposals');

  const sent = await prop.find({ org_id: 'company', sent_at: { $gte: start, $lt: end } })
    .sort({ sent_at: 1 }).toArray();
  console.log(`MESSAGES ACTUALLY DELIVERED today: ${sent.length}`);
  sent.forEach((r) => console.log(
    `  ${new Date(r.sent_at).toISOString().slice(11, 16)}  ${String(r.customer_phone).padEnd(15)} ${r.customer_name || '-'}`));

  const failedToday = await prop.countDocuments({
    org_id: 'company', status: 'failed', created_at: { $gte: start, $lt: end } });
  console.log(`\nfailed proposals created today   : ${failedToday}`);

  // Whatever the server uses to count the cap.
  const ws = await db.collection('outreach_worker_state').find({}).toArray();
  console.log('\n=== outreach_worker_state ===');
  ws.forEach((w) => console.log(JSON.stringify(w, null, 2)));

  const attemptCols = await db.listCollections().toArray();
  const names = attemptCols.map((c) => c.name).filter((n) => /attempt|ledger|cap|contacted/i.test(n));
  console.log(`\ncandidate ledger collections: ${names.join(', ') || '(none)'}`);
  for (const n of names) {
    const c = await db.collection(n).countDocuments({ $or: [
      { created_at: { $gte: start, $lt: end } }, { updated_at: { $gte: start, $lt: end } } ] });
    console.log(`  ${n}: ${c} rows touched today`);
  }

  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
