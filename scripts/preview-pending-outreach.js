// Show full content of approved/pending outreach proposals so the operator
// can decide whether to send, redirect, or delete. Read-only.
// Run: railway run node scripts/preview-pending-outreach.js

const { MongoClient } = require('mongodb');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set; run via `railway run …`');
    process.exit(1);
  }
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();

  const rows = await db.collection('outreach_proposals')
    .find({ status: { $in: ['pending', 'approved', 'in_flight'] } })
    .sort({ approved_at: 1, created_at: 1 })
    .toArray();

  console.log(`DB: ${db.databaseName}`);
  console.log(`Total claimable rows: ${rows.length}\n`);

  for (const r of rows) {
    console.log('────────────────────────────────────');
    console.log(`_id              ${r._id}`);
    console.log(`status           ${r.status}`);
    console.log(`customer_phone   ${r.customer_phone}`);
    console.log(`customer_name    ${r.customer_name ?? '(none)'}`);
    console.log(`follower         ${r.follower ?? '(none)'}`);
    console.log(`approved_at      ${r.approved_at ?? '—'}`);
    console.log(`approved_by      ${r.approved_by ?? '—'}`);
    console.log(`days_since_ct    ${r.days_since_contact ?? '—'}`);
    console.log(`model            ${r.model}`);
    console.log(`message:`);
    console.log(`  ${r.message?.replace(/\n/g, '\n  ') ?? '(empty)'}`);
    console.log(`reasoning:`);
    console.log(`  ${r.reasoning?.replace(/\n/g, '\n  ') ?? '(empty)'}`);
  }

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
