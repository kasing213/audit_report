// Read-only: report privacy suppressions and send-timeout failures.
require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  console.log('db:', db.databaseName);

  // ---- 1. PRIVACY ----
  const sup = db.collection('outreach_suppressions');
  const byKind = await sup.aggregate([
    { $group: { _id: { kind: '$failure_kind', org: '$org_id' }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]).toArray();
  console.log('\n=== outreach_suppressions by kind/org ===');
  byKind.forEach(r => console.log(`${String(r._id.kind).padEnd(10)} ${String(r._id.org).padEnd(12)} ${r.n}`));

  const privReasons = await sup.aggregate([
    { $match: { failure_kind: 'privacy' } },
    { $group: { _id: '$last_failed_reason', n: { $sum: 1 }, last: { $max: '$last_failed_at' } } },
    { $sort: { n: -1 } },
  ]).toArray();
  console.log('\n=== privacy — distinct reasons ===');
  privReasons.forEach(r => console.log(`${String(r.n).padStart(5)}  ${r.last ? new Date(r.last).toISOString().slice(0,10) : '-'}  ${r._id}`));

  const privRecent = await sup.find({ failure_kind: 'privacy' })
    .sort({ last_failed_at: -1 }).limit(10).toArray();
  console.log('\n=== privacy — 10 most recent ===');
  privRecent.forEach(r => console.log(
    `${r.last_failed_at ? new Date(r.last_failed_at).toISOString().slice(0,16) : '-'}  ` +
    `${String(r.customer_phone).padEnd(15)} ${String(r.customer_name || '-').slice(0,20).padEnd(20)} ` +
    `att=${r.attempts ?? '-'} status=${r.status} org=${r.org_id}`));

  // ---- 2. TIMEOUTS ----
  const prop = db.collection('outreach_proposals');
  const failedByReason = await prop.aggregate([
    { $match: { status: 'failed' } },
    { $group: { _id: '$failed_reason', n: { $sum: 1 }, last: { $max: '$created_at' } } },
    { $sort: { n: -1 } }, { $limit: 25 },
  ]).toArray();
  console.log('\n=== outreach_proposals status=failed, by failed_reason ===');
  failedByReason.forEach(r => console.log(`${String(r.n).padStart(5)}  ${r._id}`));

  const to = await prop.find({ failed_reason: /timed out/i })
    .sort({ created_at: -1 }).limit(20).toArray();
  console.log(`\n=== send-timeout proposals: ${await prop.countDocuments({ failed_reason: /timed out/i })} total, latest 20 ===`);
  to.forEach(r => console.log(
    `${new Date(r.created_at).toISOString().slice(0,16)}  ${String(r.customer_phone).padEnd(15)} ` +
    `${String(r.customer_name || '-').slice(0,18).padEnd(18)} img=${r.custom_image_id ? 'Y' : 'n'} ` +
    `retries=${r.transient_retries ?? 0} org=${r.org_id} :: ${r.failed_reason}`));

  // did the timed-out phone eventually succeed / get suppressed?
  const phones = [...new Set(to.map(r => r.customer_phone))];
  if (phones.length) {
    const sups = await sup.find({ customer_phone: { $in: phones } }).toArray();
    console.log('\n=== suppression state of timed-out phones ===');
    phones.forEach(p => {
      const s = sups.find(x => x.customer_phone === p);
      console.log(`${String(p).padEnd(15)} ${s ? `${s.failure_kind}/${s.status}` : 'none'}`);
    });
    const sent = await prop.countDocuments({ customer_phone: { $in: phones }, status: 'sent' });
    console.log(`later sent OK (any proposal for those phones): ${sent}`);
  }

  // worker heartbeat
  const st = await db.collection('outreach_worker_state').find({}).toArray();
  console.log('\n=== worker state ===');
  st.forEach(s => console.log(`${s.org_id} sent_today=${s.sent_today} last_error=${s.last_error} updated=${s.updated_at && new Date(s.updated_at).toISOString().slice(0,16)}`));

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
