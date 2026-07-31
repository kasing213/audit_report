require('./check-db').useScratchDb();

/**
 * Verifies the per-org top-up scan:
 *
 *  PART A — OutreachRepository.countOutstanding(orgId) counts only
 *  pending/approved proposals, excludes sent/failed/skipped/in_flight, and is
 *  scoped per org (a 'personal' proposal must not count toward 'company').
 *
 *  PART B — computeDraftCount(outstanding, target), the scheduler's pure
 *  top-up decision extracted from src/scheduler/outreach-scheduler.ts, tops
 *  the queue UP TO target rather than adding target.
 *
 *  PART C — drives the REAL compiled OutreachScheduler (dist/scheduler/
 *  outreach-scheduler.js) end to end against seeded stale-customer and
 *  worker-state fixtures, and asserts on what actually lands in
 *  outreach_proposals. This is what catches wiring regressions Parts A/B
 *  cannot see: passing the org OBJECT instead of org.id, dropping the
 *  per-org try/catch, or caching auto_approve across ticks.
 *
 * Runs against a scratch database (Audit_check on the same cluster), never
 * production `Audit` — see scripts/check-db.js.
 *
 * Usage: node scripts/check-scan-topup.js
 */
// Pin the scan's tunables so this check is deterministic regardless of any
// ambient .env values — the defaults happen to match, but we don't want a
// future .env edit to silently change what this script proves.
process.env.OUTREACH_QUEUE_TARGET = '20';
process.env.OUTREACH_STALE_DAYS = '45';

const { MongoClient } = require('mongodb');

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
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
  const { computeDraftCount, OutreachScheduler } = require('../dist/scheduler/outreach-scheduler');
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

  // ===========================================================================
  // PART A — countOutstanding: seed a known mix of statuses for 'company' and
  // verify only pending+approved are counted (2 outstanding out of 6 seeded).
  // ===========================================================================
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

  // ===========================================================================
  // PART B — computeDraftCount: the scheduler's real top-up decision, extracted
  // as a pure function (see task-6-report.md — invoking the scheduler
  // end-to-end via cron/HTTP for every arithmetic edge case was impractical, so
  // the decision logic was pulled out of runScanForOrg and asserted directly
  // here). PART C below still drives the real scheduler class for the cases
  // that actually need it (org identity, per-org isolation, fresh reads).
  // ===========================================================================
  check('computeDraftCount: 0 outstanding drafts 20', computeDraftCount(0, 20), 20);
  check('computeDraftCount: 8 outstanding drafts 12', computeDraftCount(8, 20), 12);
  check('computeDraftCount: 19 outstanding drafts 1', computeDraftCount(19, 20), 1);
  check('computeDraftCount: 20 outstanding drafts 0', computeDraftCount(20, 20), 0);
  check('computeDraftCount: 25 outstanding (over target) drafts 0', computeDraftCount(25, 20), 0);
  check('computeDraftCount: respects a custom target of 5', computeDraftCount(2, 5), 3);

  // ===========================================================================
  // PART C — real OutreachScheduler, driven end to end against scratch data.
  // Reserves the +8559771 (scenario phones) and +8559772 (queue-filler phones)
  // blocks so it never collides with Part A's +855999xxxxxx fixtures or real
  // data. All seeded leads_events / outreach_proposals / worker_state changes
  // are cleaned up at the end, including restoring each org's original
  // auto_approve value.
  // ===========================================================================
  const leadsCol = db.collection('leads_events');
  const stateCol = db.collection('outreach_worker_state');
  const SCENARIO_PREFIX = '+8559771';
  const FILLER_PREFIX = '+8559772';

  const P1_COMPANY_TICK1 = `${SCENARIO_PREFIX}00001`; // company, auto ON  -> approved
  const P2_PERSONAL_TICK1 = `${SCENARIO_PREFIX}00002`; // personal, auto OFF -> pending
  const P3_COMPANY_TICK2 = `${SCENARIO_PREFIX}00003`; // company, flipped OFF -> pending (no caching)
  const P4_PERSONAL_TICK3 = `${SCENARIO_PREFIX}00004`; // personal, drafted while company's scan throws
  const P5_PERSONAL_CEILING = `${SCENARIO_PREFIX}00005`; // personal, queue already at target -> must NOT be drafted

  async function resetScenarioData() {
    await leadsCol.deleteMany({ 'customer.phone': { $regex: `^\\${SCENARIO_PREFIX}` } });
    await col.deleteMany({
      customer_phone: { $regex: `^\\${SCENARIO_PREFIX}|^\\${FILLER_PREFIX}` },
    });
  }
  await resetScenarioData();

  function makeStaleLead(orgId, phone) {
    return {
      org_id: orgId,
      date: '2000-01-01', // far older than any staleDays threshold
      customer: { name: 'Scan Topup Fixture', phone },
      page: 'check-scan-topup.js',
      destination: null,
      follower: 'check-scan-topup',
      status_text: 'test fixture',
      reason_code: null,
      note: null,
      deleted: false,
      source: { telegram_msg_id: 'check-scan-topup', model: 'check-script' },
      created_at: new Date('2000-01-01'),
    };
  }

  async function findProposal(phone, orgId) {
    return col.findOne({ customer_phone: phone, org_id: orgId });
  }

  // Save each org's real worker-state doc so we can restore it exactly,
  // regardless of what it looked like before this script ran.
  const originalCompanyState = await stateCol.findOne({ _id: 'company' });
  const originalPersonalState = await stateCol.findOne({ _id: 'personal' });

  async function setAutoApprove(orgId, autoApprove) {
    await stateCol.updateOne(
      { _id: orgId },
      {
        $set: { auto_approve: autoApprove, updated_at: new Date() },
        $setOnInsert: {
          paused: false,
          last_heartbeat_at: null,
          worker_id: null,
          sent_today: 0,
          claims_today: 0,
          deliveries_today: 0,
          claims_today_day: null,
          last_error: null,
        },
      },
      { upsert: true }
    );
  }

  const scheduler = new OutreachScheduler();

  try {
    // --- C1: both workspaces scanned in the same tick, mode read per org. ---
    // company=ON, personal=OFF. If runScan ever passed the org OBJECT instead
    // of org.id, normalizeOrg() would silently coerce it to the default org
    // ('company'), so the 'personal'-tagged candidate below would never be
    // found (its leads_events doc is tagged org_id:'personal', which a
    // mis-normalized company-scoped query does not match) — this assertion
    // catches that class of bug, not just an object-vs-string type check.
    await setAutoApprove('company', true);
    await setAutoApprove('personal', false);
    await leadsCol.insertMany([
      makeStaleLead('company', P1_COMPANY_TICK1),
      makeStaleLead('personal', P2_PERSONAL_TICK1),
    ]);

    await scheduler.triggerNow();

    const p1 = await findProposal(P1_COMPANY_TICK1, 'company');
    check('C1: company (auto ON) drafted a proposal', Boolean(p1), true);
    check('C1: company proposal status is approved', p1 && p1.status, 'approved');
    check('C1: company proposal approved_by is auto-approve', p1 && p1.approved_by, 'auto-approve');

    const p2 = await findProposal(P2_PERSONAL_TICK1, 'personal');
    check('C1: personal (auto OFF) drafted a proposal in the SAME tick', Boolean(p2), true);
    check('C1: personal proposal status is pending', p2 && p2.status, 'pending');
    check('C1: personal proposal approved_by is null', p2 && p2.approved_by, null);

    // --- C2: flip company OFF, run another tick, prove auto_approve is read
    // fresh (not cached from C1's true value or cached on the scheduler
    // instance, which is reused here on purpose). ---
    await setAutoApprove('company', false);
    await leadsCol.insertOne(makeStaleLead('company', P3_COMPANY_TICK2));

    await scheduler.triggerNow();

    const p3 = await findProposal(P3_COMPANY_TICK2, 'company');
    check('C2: company (flipped to OFF) drafted a proposal', Boolean(p3), true);
    check('C2: company proposal is now pending (no caching of ON from C1)', p3 && p3.status, 'pending');
    check('C2: company proposal approved_by is null', p3 && p3.approved_by, null);

    // --- C3: per-org failure isolation. Monkey-patch countOutstanding at
    // runtime (nothing in src/ changes) so the FIRST call in this tick throws;
    // OUTREACH_ORGS is scanned in registry order [company, personal], so this
    // reliably hits company and leaves personal's call untouched. ---
    const repoProto = require('../dist/outreach/outreach-repository').OutreachRepository.prototype;
    const originalCountOutstanding = repoProto.countOutstanding;
    let injectedFailureThrown = false;
    repoProto.countOutstanding = async function patchedCountOutstanding(orgId) {
      if (!injectedFailureThrown) {
        injectedFailureThrown = true;
        throw new Error('injected failure from check-scan-topup.js (C3)');
      }
      return originalCountOutstanding.call(this, orgId);
    };

    await leadsCol.insertOne(makeStaleLead('personal', P4_PERSONAL_TICK3));

    let triggerThrew = false;
    try {
      await scheduler.triggerNow();
    } catch {
      triggerThrew = true;
    } finally {
      repoProto.countOutstanding = originalCountOutstanding;
    }

    check('C3: injected failure actually fired', injectedFailureThrown, true);
    check('C3: triggerNow() does not throw when one org fails', triggerThrew, false);
    const p4 = await findProposal(P4_PERSONAL_TICK3, 'personal');
    check("C3: personal still drafted despite company's scan throwing", Boolean(p4), true);
    check('C3: personal proposal status is pending', p4 && p4.status, 'pending');

    // --- C4: top-up ceiling, end to end. Fill personal's queue to exactly
    // target (20), seed one more stale candidate, run a tick, and assert
    // nothing new was drafted for it. ---
    const target = 20;
    const personalOutstandingBefore = await repo.countOutstanding('personal');
    const fillersNeeded = Math.max(0, target - personalOutstandingBefore);
    const fillerDocs = [];
    for (let i = 0; i < fillersNeeded; i++) {
      const doc = makeProposal('personal', 'pending', '');
      doc.customer_phone = `${FILLER_PREFIX}${String(i).padStart(5, '0')}`;
      doc.generation_id = 'check-scan-topup-filler';
      fillerDocs.push(doc);
    }
    if (fillerDocs.length > 0) await col.insertMany(fillerDocs);

    const personalOutstandingAtCeiling = await repo.countOutstanding('personal');
    check('C4: personal queue filled to exactly target (20)', personalOutstandingAtCeiling, target);

    await leadsCol.insertOne(makeStaleLead('personal', P5_PERSONAL_CEILING));
    await scheduler.triggerNow();

    const p5 = await findProposal(P5_PERSONAL_CEILING, 'personal');
    check('C4: candidate at full queue is NOT drafted', p5, null);
    const personalOutstandingAfter = await repo.countOutstanding('personal');
    check('C4: personal outstanding unchanged by the tick (still at target)', personalOutstandingAfter, target);
  } finally {
    // Cleanup: scenario leads/proposals, filler proposals, and restore each
    // org's original worker-state doc exactly as found (or remove it if it
    // didn't exist before this script ran).
    await resetScenarioData();
    await col.deleteMany({ generation_id: 'check-scan-topup-filler' });

    if (originalCompanyState) {
      await stateCol.replaceOne({ _id: 'company' }, originalCompanyState);
    } else {
      await stateCol.deleteOne({ _id: 'company' });
    }
    if (originalPersonalState) {
      await stateCol.replaceOne({ _id: 'personal' }, originalPersonalState);
    } else {
      await stateCol.deleteOne({ _id: 'personal' });
    }
  }

  await client.close();
  await DatabaseConnection.getInstance().disconnect();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
