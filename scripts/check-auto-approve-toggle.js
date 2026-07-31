require('./check-db').useScratchDb();

/**
 * Verifies the per-org auto_approve flag: independent per workspace, and an
 * absent field reads as false (today's manual behaviour).
 *
 * Usage: node scripts/check-auto-approve-toggle.js
 *
 * Runs against a scratch database (Audit_check on the same cluster), never
 * production `Audit` — see scripts/check-db.js.
 */
const { MongoClient } = require('mongodb');

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (got ${actual}, want ${expected})`);
}

(async () => {
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error('DATABASE_URL not set');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  console.log(`Connected to database: ${db.databaseName}`);
  if (db.databaseName !== 'Audit_check') {
    console.error(`REFUSING to run: expected scratch database "Audit_check", got "${db.databaseName}"`);
    await client.close();
    process.exit(1);
  }
  const col = db.collection('outreach_worker_state');

  const { OutreachWorkerStateRepository } = require('../dist/outreach/outreach-worker-state-repository');
  const DatabaseConnection = require('../dist/database/connection').default;
  await DatabaseConnection.getInstance().connect();
  const repo = new OutreachWorkerStateRepository();

  // Clean slate — scratch db has no pre-existing worker-state docs, so create
  // what we need from scratch rather than assuming they exist.
  await col.deleteMany({});

  // Absent field reads false.
  await repo.setAutoApprove('company', false); // creates the doc via ensureOrg()
  await col.updateOne({ _id: 'company' }, { $unset: { auto_approve: '' } });
  const bare = await repo.getStatus('company');
  check('absent auto_approve reads false', bare.auto_approve === true, false);

  // Independent per org.
  await repo.setAutoApprove('company', true);
  await repo.setAutoApprove('personal', false);
  const co = await repo.getStatus('company');
  const pe = await repo.getStatus('personal');
  check('company auto_approve set true', co.auto_approve, true);
  check('personal unaffected', pe.auto_approve, false);

  // Pause flag untouched by the auto-approve write.
  check('paused untouched by setAutoApprove', typeof co.paused, 'boolean');

  // Restore manual on both so the check leaves no side effects.
  await repo.setAutoApprove('company', false);
  await repo.setAutoApprove('personal', false);

  await client.close();
  await DatabaseConnection.getInstance().disconnect();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
