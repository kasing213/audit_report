// Read-only evidence gathering: daily send/fail rates and today's detail.
require('dotenv').config();
const { MongoClient } = require('mongodb');

const day = (d) => new Date(d).toISOString().slice(0, 10);

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  const prop = db.collection('outreach_proposals');
  const sup = db.collection('outreach_suppressions');

  // --- Daily outcome rate, by generation day ---
  console.log('=== proposals by created day x status ===');
  const rows = await prop.aggregate([
    { $group: { _id: { d: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } }, s: '$status' }, n: { $sum: 1 } } },
    { $sort: { '_id.d': 1 } },
  ]).toArray();
  const table = {};
  rows.forEach(r => { (table[r._id.d] ||= {})[r._id.s] = r.n; });
  console.log('date         sent  failed  appr  pend  skip   fail%');
  for (const [d, v] of Object.entries(table)) {
    const sent = v.sent || 0, failed = v.failed || 0;
    const rate = sent + failed ? Math.round(100 * failed / (sent + failed)) : 0;
    console.log(`${d}  ${String(sent).padStart(4)}  ${String(failed).padStart(6)}  ${String(v.approved||0).padStart(4)}  ${String(v.pending||0).padStart(4)}  ${String(v.skipped||0).padStart(4)}   ${rate}%`);
  }

  // --- Suppression records by day recorded (the real "when did it fail" clock) ---
  console.log('\n=== suppressions by last_failed_at day x kind ===');
  const sr = await sup.aggregate([
    { $match: { last_failed_at: { $ne: null } } },
    { $group: { _id: { d: { $dateToString: { format: '%Y-%m-%d', date: '$last_failed_at' } }, k: '$failure_kind' }, n: { $sum: 1 } } },
    { $sort: { '_id.d': 1 } },
  ]).toArray();
  const t2 = {};
  sr.forEach(r => { (t2[r._id.d] ||= {})[r._id.k] = r.n; });
  for (const [d, v] of Object.entries(t2)) {
    console.log(`${d}  ${Object.entries(v).map(([k, n]) => `${k}=${n}`).join('  ')}`);
  }

  // --- Contacted (successful) records by day ---
  console.log('\n=== successful contacts (recordContacted) by day ===');
  const cr = await sup.aggregate([
    { $match: { failure_kind: 'contacted' } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$updated_at' } }, n: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  cr.forEach(r => console.log(`${r._id}  ${r.n}`));

  // --- sent_at by day: the true delivery clock ---
  console.log('\n=== proposals actually SENT, by sent_at day ===');
  const sd = await prop.aggregate([
    { $match: { sent_at: { $ne: null } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$sent_at' } }, n: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  sd.forEach(r => console.log(`${r._id}  ${r.n}`));

  // --- Today's proposals in full ---
  const start = new Date('2026-08-01T00:00:00Z'), end = new Date('2026-08-02T00:00:00Z');
  const today = await prop.find({ created_at: { $gte: start, $lt: end } }).sort({ _id: 1 }).toArray();
  console.log(`\n=== proposals created today (2026-08-01): ${today.length} ===`);
  today.forEach(r => console.log(
    `${String(r.customer_phone).padEnd(15)} ${String(r.customer_name||'-').slice(0,18).padEnd(18)} ` +
    `${String(r.status).padEnd(9)} appr=${r.approved_at ? new Date(r.approved_at).toISOString().slice(11,16) : '-'} ` +
    `sent=${r.sent_at ? new Date(r.sent_at).toISOString().slice(11,16) : '-'} :: ${r.failed_reason || ''}`));

  // --- Anything failing today regardless of creation date ---
  const failedToday = await sup.find({ last_failed_at: { $gte: start, $lt: end } }).sort({ last_failed_at: 1 }).toArray();
  console.log(`\n=== suppressions with last_failed_at TODAY: ${failedToday.length} ===`);
  failedToday.forEach(r => console.log(
    `${new Date(r.last_failed_at).toISOString().slice(11,16)}  ${String(r.customer_phone).padEnd(15)} ` +
    `${String(r.failure_kind).padEnd(9)} attempts=${r.attempts ?? '-'} :: ${r.last_failed_reason}`));

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
