require('./check-db').useScratchDb();

/**
 * Verifies the per-org top-up scan:
 *
 *  1. OutreachRepository.countOutstanding(orgId) counts only pending/approved
 *     proposals, excludes sent/failed/skipped/in_flight, and is scoped per org
 *     (a 'personal' proposal must not count toward 'company').
 *  2. computeDraftCount(outstanding, target) — the scheduler's pure top-up
 *     decision, extracted from src/scheduler/outreach-scheduler.ts — tops the
 *     queue UP TO target rather than adding target: with N outstanding it
 *     drafts max(0, target-N), and N>=target drafts 0.
 *
 * Runs against a scratch database (Audit_check on the same cluster), never
 * production `Audit` — see scripts/check-db.js.
 *
 * Usage: node scripts/check-scan-topup.js
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

  const col = db.collection('outreach_proposals');
  const TAG = 'check-scan-topup';
  await col.deleteMany({ generation_id: TAG });

  const DatabaseConnection = require('../dist/database/connection').default;
  await DatabaseConnection.getInstance().connect();
  const { OutreachRepository } = require('../dist/outreach/outreach-repository');
  const { computeDraftCount } = require('../dist/scheduler/outreach-scheduler');
  const repo = new OutreachRepository();

  function makeProposal(orgId, status, phoneSuffix) {
    return {
      org_id: orgId,
      generation_id: TAG,
      customer_phone: `+855999${phoneSuffix}`,
      customer_name: 'Test Customer',
      reason_code: null,
      days_since_contact: null,
      follower: null,
      message: 'test',
      reasoning: 'test fixture',
      status,
      skipped_reason: null,
      failed_reason: null,
      custom_image_id: null,
      created_at: new Date(),
      approved_at: status === 'approved' ? new Date() : null,
      approved_by: null,
      sent_at: status === 'sent' ? new Date() : null,
      lease_expires_at: null,
      model: 'static',
    };
  }

  // --- countOutstanding: seed a known mix of statuses for 'company' and
  // verify only pending+approved are counted (2 outstanding out of 6 seeded).
  await col.insertMany([
    makeProposal('company', 'pending', '000001'),
    makeProposal('company', 'approved', '000002'),
    makeProposal('company', 'sent', '000003'),
    makeProposal('company', 'failed', '000004'),
    makeProposal('company', 'skipped', '000005'),
    makeProposal('company', 'in_flight', '000006'),
    // A 'personal' outstanding proposal must NOT count toward 'company'.
    makeProposal('personal', 'pending', '000007'),
    makeProposal('personal', 'approved', '000008'),
  ]);

  check('countOutstanding counts only pending+approved for company', await repo.countOutstanding('company'), 2);
  check('countOutstanding excludes sent/failed/skipped/in_flight', await repo.countOutstanding('company'), 2);
  check('countOutstanding is scoped per org: personal has its own 2', await repo.countOutstanding('personal'), 2);

  // Add more outstanding to company only, confirm personal is unaffected
  // (proves the scoping isn't accidentally symmetric/coincidental).
  await col.insertMany([
    makeProposal('company', 'pending', '000009'),
    makeProposal('company', 'approved', '000010'),
  ]);
  check('countOutstanding company reflects new total (4)', await repo.countOutstanding('company'), 4);
  check('countOutstanding personal unaffected by company inserts', await repo.countOutstanding('personal'), 2);

  await col.deleteMany({ generation_id: TAG });

  // --- computeDraftCount: the scheduler's real top-up decision, extracted as
  // a pure function (see AMENDMENT in task-6-brief.md — invoking the scheduler
  // end-to-end via cron/HTTP was impractical for a unit check, so the decision
  // logic itself was pulled out of runScanForOrg and asserted directly here;
  // this proves the arithmetic the scheduler executes, not just a restatement
  // of Math.max in the test).
  check('computeDraftCount: 0 outstanding drafts 20', computeDraftCount(0, 20), 20);
  check('computeDraftCount: 8 outstanding drafts 12', computeDraftCount(8, 20), 12);
  check('computeDraftCount: 19 outstanding drafts 1', computeDraftCount(19, 20), 1);
  check('computeDraftCount: 20 outstanding drafts 0', computeDraftCount(20, 20), 0);
  check('computeDraftCount: 25 outstanding (over target) drafts 0', computeDraftCount(25, 20), 0);
  check('computeDraftCount: respects a custom target of 5', computeDraftCount(2, 5), 3);

  await client.close();
  await DatabaseConnection.getInstance().disconnect();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
