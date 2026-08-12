// Read-only. Verifies every outreach_media doc has an org_id set.
//
// Why this matters: orgMatch('company') (src/outreach/orgs.ts) treats a
// missing/null org_id as belonging to 'company' — deliberate for legacy
// pre-multi-org data, but any outreach_media doc left in that state is a
// cross-tenant leak waiting to happen, since OutreachVideoRepository.listAll
// (src/outreach/outreach-video-repository.ts) uses orgMatch() directly. This
// is exactly how a 'personal' video reached a 'company' customer on
// 2026-08-12 — see OUTREACH_RUNBOOK.md.
//
// Run with: railway run node scripts/check-outreach-media-org-ids.js
// Exits non-zero (and prints every offending doc) if any are found.

const { MongoClient } = require('mongodb');

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set; run via `railway run node scripts/check-outreach-media-org-ids.js`');
    process.exit(1);
  }
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();
  console.log('DB:', db.databaseName);

  const col = db.collection('outreach_media');
  const bad = await col.find({ $or: [{ org_id: null }, { org_id: { $exists: false } }] }).toArray();

  if (bad.length > 0) {
    console.error(`\nFAIL: ${bad.length} outreach_media doc(s) with null/missing org_id:`);
    for (const d of bad) {
      console.error(JSON.stringify({
        _id: d._id,
        org_id: d.org_id ?? null,
        filename: d.filename,
        r2_key: d.r2_key,
        size_bytes: d.size_bytes,
        uploaded_at: d.uploaded_at,
      }));
    }
    await client.close();
    process.exit(1);
  }

  console.log('PASS: no outreach_media docs with null/missing org_id');
  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
