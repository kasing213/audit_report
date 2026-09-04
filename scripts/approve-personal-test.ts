// Approve the personal pending proposal for the test number so the personal
// worker claims + sends it. End-to-end proof of the personal send path.
import DatabaseConnection from '../src/database/connection';

(async () => {
  const db = await DatabaseConnection.getInstance().connect();
  const col = db.collection('outreach_proposals');
  const r = await col.updateOne(
    { customer_phone: '+85570597666', org_id: 'personal', status: 'pending' },
    { $set: { status: 'approved', approved_at: new Date(), approved_by: 'manual-test' } }
  );
  console.log('approved personal proposals:', r.modifiedCount);
  await DatabaseConnection.getInstance().disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
