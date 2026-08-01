/**
 * Verifies the unblock via the SAME code path generation uses
 * (getSuppressedPhones), not a hand-rolled count.
 * Usage: node scripts/verify-unblock.js
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const SAMPLE = ['+85581496675', '+855974977978', '+855962816168', '+85517595778', '+85570227765'];

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();

  const DatabaseConnection = require('../dist/database/connection').default;
  await DatabaseConnection.getInstance().connect();
  const { OutreachSuppressionRepository } = require('../dist/outreach/outreach-suppression-repository');
  const suppressed = await new OutreachSuppressionRepository().getSuppressedPhones('company');

  console.log(`phones actually suppressed for 'company': ${suppressed.size}`);
  console.log('\nsample of the 69 just resolved — all should read UNBLOCKED:');
  let bad = 0;
  for (const p of SAMPLE) {
    const blocked = suppressed.has(p);
    if (blocked) bad++;
    console.log(`  ${p.padEnd(15)} ${blocked ? 'STILL BLOCKED' : 'UNBLOCKED'}`);
  }

  const resolved = await db.collection('outreach_suppressions')
    .countDocuments({ failure_kind: 'privacy', status: 'resolved' });
  const stillActive = await db.collection('outreach_suppressions')
    .countDocuments({ failure_kind: { $in: ['privacy', 'invalid'] }, status: { $in: ['active', 'exhausted'] } });
  console.log(`\nprivacy suppressions now resolved : ${resolved}`);
  console.log(`still permanently blocking        : ${stillActive}`);

  const pool = (await db.collection('leads_events').distinct('customer.phone')).filter(Boolean);
  console.log(`contactable (pool - suppressed)   : ${pool.filter((p) => !suppressed.has(p)).length} of ${pool.length}`);

  await client.close();
  await DatabaseConnection.getInstance().disconnect();
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
