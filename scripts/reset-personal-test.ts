// Re-arm the personal test proposal (failed -> approved) so the worker retries.
import DatabaseConnection from '../src/database/connection';

(async () => {
  const db = await DatabaseConnection.getInstance().connect();
  const r = await db.collection('outreach_proposals').updateOne(
    { customer_phone: '+85570597666', org_id: 'personal' },
    { $set: { status: 'approved', failed_reason: null, lease_expires_at: null, claim_attempts: 0, approved_at: new Date(), approved_by: 'manual-test' } }
  );
  console.log('re-armed personal proposal:', r.modifiedCount);
  await DatabaseConnection.getInstance().disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
