// Read-only diagnostics for the 070597666 test + recent outreach state.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');
(async () => {
  const c = new MongoClient(process.env.DATABASE_URL);
  await c.connect();
  const db = c.db();

  console.log('=== leads_events matching 597666 ===');
  const leads = await db.collection('leads_events')
    .find({ 'customer.phone': { $regex: '597666' } })
    .project({ 'customer.phone': 1, org_id: 1, date: 1, 'source.model': 1 })
    .sort({ created_at: -1 }).limit(10).toArray();
  console.log(`count: ${leads.length}`);
  for (const r of leads) console.log(`  org=${r.org_id || 'null'}  phone=${r.customer?.phone}  date=${r.date}  src=${r.source?.model}`);

  console.log('\n=== outreach_proposals: recent 12 (any phone) ===');
  const props = await db.collection('outreach_proposals')
    .find({})
    .project({ customer_phone: 1, org_id: 1, status: 1, created_at: 1, approved_by: 1 })
    .sort({ created_at: -1 }).limit(12).toArray();
  for (const r of props) console.log(`  org=${r.org_id || 'null'}  status=${r.status}  phone=${r.customer_phone}  by=${r.approved_by || '-'}`);

  console.log('\n=== proposal counts by (org,status) ===');
  const agg = await db.collection('outreach_proposals').aggregate([
    { $group: { _id: { org: '$org_id', status: '$status' }, n: { $sum: 1 } } },
    { $sort: { '_id.org': 1, '_id.status': 1 } },
  ]).toArray();
  for (const r of agg) console.log(`  org=${r._id.org || 'null'}  status=${r._id.status}  count=${r.n}`);

  console.log('\n=== suppression matching 597666 ===');
  const sup = await db.collection('outreach_suppressions')
    .find({ customer_phone: { $regex: '597666' } })
    .project({ customer_phone: 1, org_id: 1, failure_kind: 1, status: 1 }).toArray();
  console.log(`count: ${sup.length}`);
  for (const r of sup) console.log(`  org=${r.org_id || 'null'}  phone=${r.customer_phone}  kind=${r.failure_kind}  status=${r.status}`);

  await c.close();
})().catch((e) => { console.error(e); process.exit(1); });
