// One-shot migration for the two-org (company/personal) outreach split.
//
// Everything that existed before multi-org belongs to the DEFAULT org, 'company'.
// This stamps org_id='company' on the data collections, migrates the singleton
// worker-state doc to a per-org 'company' doc (preserving today's counters), and
// drops the legacy single-field unique index on outreach_suppressions so the new
// compound (org_id, customer_phone) unique index can take over.
//
// Safe by default:
//   node scripts/backfill-org-company.js            # dry-run, shows what would change
//   node scripts/backfill-org-company.js --confirm  # actually apply
//
// DATABASE_URL is read from the repo-root .env (or ambient env, so
// `railway run node scripts/backfill-org-company.js --confirm` also works).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

const COMPANY = 'company';
// org_id absent OR explicitly null → belongs to company.
const MISSING_ORG = { $or: [{ org_id: { $exists: false } }, { org_id: null }] };

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

  // 1. Stamp org_id='company' on the three data collections where missing.
  for (const coll of ['leads_events', 'outreach_proposals', 'outreach_suppressions']) {
    const c = db.collection(coll);
    const pending = await c.countDocuments(MISSING_ORG);
    console.log(`${coll}: ${pending} doc(s) missing org_id → '${COMPANY}'`);
    if (confirm && pending > 0) {
      const r = await c.updateMany(MISSING_ORG, { $set: { org_id: COMPANY } });
      console.log(`  updated ${r.modifiedCount}`);
    }
  }

  // 2. Migrate the singleton worker-state doc to a per-org 'company' doc so the
  //    daily counters (claims_today/deliveries_today) carry over. Idempotent.
  const ws = db.collection('outreach_worker_state');
  const singleton = await ws.findOne({ _id: 'singleton' });
  const companyState = await ws.findOne({ _id: COMPANY });
  if (singleton && !companyState) {
    console.log(`outreach_worker_state: copy singleton → '${COMPANY}' (preserving counters)`);
    if (confirm) {
      const clone = { ...singleton, _id: COMPANY };
      await ws.insertOne(clone);
      await ws.deleteOne({ _id: 'singleton' });
      console.log('  migrated and removed old singleton');
    }
  } else if (companyState) {
    console.log(`outreach_worker_state: '${COMPANY}' doc already exists — skip`);
  } else {
    console.log('outreach_worker_state: no singleton doc — nothing to migrate (fresh init will create per-org)');
  }

  // 3. Re-key the singleton "default branding" docs (message / image / video)
  //    from _id:'default' to _id:'default:company'. _id is immutable, so this is
  //    an insert-clone + delete-old. Without it the per-org repos (which now read
  //    'default:company') would not find the existing company branding.
  for (const coll of ['outreach_settings', 'outreach_images', 'outreach_media']) {
    const c = db.collection(coll);
    const oldDoc = await c.findOne({ _id: 'default' });
    const newDoc = await c.findOne({ _id: 'default:' + COMPANY });
    if (oldDoc && !newDoc) {
      console.log(`${coll}: re-key _id:'default' → 'default:${COMPANY}'`);
      if (confirm) {
        const clone = { ...oldDoc, _id: 'default:' + COMPANY };
        await c.insertOne(clone);
        await c.deleteOne({ _id: 'default' });
        console.log('  re-keyed');
      }
    } else if (newDoc) {
      console.log(`${coll}: 'default:${COMPANY}' already exists — skip`);
    } else {
      console.log(`${coll}: no _id:'default' doc — skip`);
    }
  }

  // 4. Drop the legacy single-field unique index so the compound org+phone one
  //    (created by the repository on boot) becomes the sole uniqueness rule.
  const sup = db.collection('outreach_suppressions');
  const idx = await sup.indexes();
  const legacy = idx.find((i) => i.name === 'phone_unique');
  if (legacy) {
    console.log("outreach_suppressions: legacy 'phone_unique' index present → drop");
    if (confirm) {
      await sup.dropIndex('phone_unique');
      console.log('  dropped');
    }
  } else {
    console.log("outreach_suppressions: no legacy 'phone_unique' index — skip");
  }

  console.log(confirm ? '\nDone.' : '\nDRY RUN — re-run with --confirm to apply.');
  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
