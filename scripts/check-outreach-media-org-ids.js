// Read-only. Verifies every outreach_media doc has an org_id set, AND that no
// two docs (in different orgs) share the same r2_key.
//
// Why org_id matters: orgMatch('company') (src/outreach/orgs.ts) treats a
// missing/null org_id as belonging to 'company' — deliberate for legacy
// pre-multi-org data, but any outreach_media doc left in that state is a
// cross-tenant leak waiting to happen, since OutreachVideoRepository.listAll
// (src/outreach/outreach-video-repository.ts) uses orgMatch() directly. This
// is exactly how a 'personal' video reached a 'company' customer on
// 2026-08-12 — see OUTREACH_RUNBOOK.md.
//
// Why r2_key matters: DELETE /default-video/:id removes the Mongo doc AND the
// R2 object at its r2_key. If two docs in different orgs ever point at the
// SAME r2_key (only possible via a bad migration/clone, never via a normal
// upload — R2StorageService.uploadVideo always mints a fresh randomUUID()),
// deleting one org's video silently breaks the other org's video: its Mongo
// doc still lists it, but the underlying file is gone from R2.
//
// Run with: railway run node scripts/check-outreach-media-org-ids.js
// Exits non-zero (and prints every offending doc/group) if any are found.

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
  const all = await col.find({}).sort({ org_id: 1, uploaded_at: 1 }).toArray();

  console.log(`\n${all.length} outreach_media doc(s) total:`);
  for (const d of all) {
    console.log(JSON.stringify({
      _id: d._id,
      org_id: d.org_id ?? null,
      filename: d.filename,
      r2_key: d.r2_key,
      size_bytes: d.size_bytes,
      uploaded_at: d.uploaded_at,
    }));
  }

  let failed = false;

  const bad = all.filter((d) => d.org_id == null);
  if (bad.length > 0) {
    failed = true;
    console.error(`\nFAIL: ${bad.length} doc(s) with null/missing org_id (matches 'company' by legacy fallback):`);
    for (const d of bad) console.error(`  ${d._id} — ${d.filename}`);
  }

  const byKey = new Map();
  for (const d of all) {
    if (!byKey.has(d.r2_key)) byKey.set(d.r2_key, []);
    byKey.get(d.r2_key).push(d);
  }
  for (const [key, docs] of byKey) {
    const orgs = new Set(docs.map((d) => d.org_id ?? null));
    if (docs.length > 1) {
      failed = true;
      console.error(`\nFAIL: r2_key ${key} is shared by ${docs.length} docs across org(s) [${[...orgs].join(', ')}] — deleting one deletes the underlying file for all of them:`);
      for (const d of docs) console.error(`  ${d._id} (org=${d.org_id ?? 'null'}) — ${d.filename}`);
    }
  }

  await client.close();
  if (failed) process.exit(1);
  console.log('\nPASS: every doc has an org_id, no r2_key is shared across docs');
})().catch((e) => { console.error(e); process.exit(1); });
