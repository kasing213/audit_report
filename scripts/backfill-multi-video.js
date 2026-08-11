// One-shot migration: outreach_media goes from ONE singleton doc per org
// (_id: 'default:<org>', upsert/replace semantics) to ONE doc PER VIDEO
// (auto _id, org_id field), enabling multiple queued videos per org.
//
// For each org, if a singleton doc still exists (either the multi-org shape
// 'default:<org>' or, for 'company' only, the pre-multi-org bare 'default'),
// re-key it into the new per-video shape: insert a clone with a fresh auto
// _id and org_id set, then delete the old singleton doc. Idempotent — if no
// singleton doc is found for an org, it's skipped (either already migrated,
// or that org never had a video set).
//
// Safe by default:
//   node scripts/backfill-multi-video.js            # dry-run, shows what would change
//   node scripts/backfill-multi-video.js --confirm  # actually apply
//
// DATABASE_URL is read from the repo-root .env (or ambient env, so
// `railway run node scripts/backfill-multi-video.js --confirm` also works).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

const ORGS = ['company', 'personal'];

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set (checked .env and ambient env).');
    process.exit(1);
  }
  const confirm = process.argv.includes('--confirm');
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();
  console.log('DB:', db.databaseName);
  console.log(confirm ? 'MODE: --confirm (applying changes)\n' : 'MODE: dry-run (no changes)\n');

  const col = db.collection('outreach_media');

  for (const orgId of ORGS) {
    const candidateIds = orgId === 'company' ? ['default:company', 'default'] : ['default:' + orgId];
    let oldDoc = null;
    for (const id of candidateIds) {
      oldDoc = await col.findOne({ _id: id });
      if (oldDoc) break;
    }
    if (!oldDoc) {
      console.log(`${orgId}: no singleton doc found — skip (already migrated or never had a video)`);
      continue;
    }
    console.log(`${orgId}: singleton doc '${oldDoc._id}' → new per-video doc (org_id='${orgId}')`);
    if (confirm) {
      const { _id, ...fields } = oldDoc;
      await col.insertOne({ ...fields, org_id: orgId });
      await col.deleteOne({ _id: oldDoc._id });
      console.log('  migrated and removed old singleton');
    }
  }

  console.log(confirm ? '\nDone.' : '\nDRY RUN — re-run with --confirm to apply.');
  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
