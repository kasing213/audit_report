require('./check-db').useScratchDb();

/**
 * Verifies that POST /crm/api/outreach/:id/mark-sent starts the phone's
 * 180-day contact cooldown (recordContacted) instead of merely clearing a
 * prior failure record (the old resolve() behavior).
 *
 * Self-contained against the scratch database (Audit_check on the same
 * cluster) — never touches production `Audit`. See scripts/check-db.js.
 *
 * Verification route: starts a minimal HTTP server as a child process
 * (ApiServer only — Express + DB connection, wired exactly like production)
 * against the scratch DATABASE_URL, then drives it over real HTTP with an
 * agent Bearer token, the same way the Telegram worker calls mark-sent. This
 * does NOT boot the full src/index.ts daemon (Telegram bot, cron schedulers)
 * since those need unrelated live credentials and add nothing to this test —
 * see task-4-report.md for the full rationale.
 *
 * Usage: npm run build && node scripts/check-marksent-cooldown.js
 */
const { MongoClient } = require('mongodb');
const { spawn } = require('child_process');
const path = require('path');

const PHONE = '+855999000333';
const ORG = 'company';
const PORT = 39231;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DASHBOARD_TOKEN = 'check-marksent-dashboard-token';
const AGENT_TOKEN = 'check-marksent-agent-token';

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, ok) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

function makeProposal(overrides) {
  const now = new Date();
  return Object.assign(
    {
      org_id: ORG,
      generation_id: 'check-marksent-gen',
      customer_phone: PHONE,
      customer_name: 'Check Marksent Customer',
      reason_code: 'stale-45',
      days_since_contact: 50,
      follower: 'kasing',
      message: 'test outreach message',
      reasoning: 'test',
      status: 'in_flight',
      skipped_reason: null,
      failed_reason: null,
      custom_image_id: null,
      created_at: now,
      approved_at: now,
      approved_by: 'tester',
      sent_at: null,
      lease_expires_at: new Date(now.getTime() + 5 * 60 * 1000),
      claim_attempts: 0,
      model: 'test',
    },
    overrides
  );
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`timed out waiting for server to listen; output so far:\n${out}`));
    }, 15000);
    const onData = (buf) => {
      out += buf.toString();
      if (!settled && out.includes(`API server running on port ${PORT}`)) {
        settled = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (buf) => process.stderr.write(`[server] ${buf}`));
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}; output so far:\n${out}`));
    });
  });
}

(async () => {
  const scratchUrl = process.env.DATABASE_URL;
  const directClient = new MongoClient(scratchUrl, { serverSelectionTimeoutMS: 10000 });
  await directClient.connect();
  const db = directClient.db();
  console.log(`Connected to database: ${db.databaseName}`);
  if (db.databaseName !== 'Audit_check') {
    console.error(`REFUSING to run: expected scratch database "Audit_check", got "${db.databaseName}"`);
    await directClient.close();
    process.exit(1);
  }
  const proposalsCol = db.collection('outreach_proposals');
  const suppCol = db.collection('outreach_suppressions');

  // Clean slate for this phone before we start (in case a prior run crashed
  // mid-way and left something behind).
  await proposalsCol.deleteMany({ customer_phone: PHONE });
  await suppCol.deleteMany({ customer_phone: PHONE });

  // Start the app server as a child process against the scratch DB. Bootstrap
  // only ApiServer (Express + DB), not the full src/index.ts daemon.
  const bootstrap = [
    "const DatabaseConnection = require('./dist/database/connection').default;",
    "const { ApiServer } = require('./dist/api/server');",
    '(async () => {',
    '  await DatabaseConnection.getInstance().connect();',
    `  new ApiServer(${PORT}).start();`,
    '})().catch((e) => { console.error(e); process.exit(1); });',
  ].join('\n');

  const child = spawn(process.execPath, ['-e', bootstrap], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      DATABASE_URL: scratchUrl,
      PORT: String(PORT),
      DASHBOARD_TOKEN,
      AGENT_TOKEN,
    }),
  });

  try {
    await waitForServer(child);
    console.log(`server listening on ${BASE_URL}`);

    // --- Case 1: fresh phone, no prior suppression record. ---
    const proposal1 = makeProposal({});
    const ins1 = await proposalsCol.insertOne(proposal1);
    const id1 = ins1.insertedId;

    const resp1 = await fetch(`${BASE_URL}/crm/api/outreach/${id1}/mark-sent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AGENT_TOKEN}` },
      body: JSON.stringify({}),
    });
    check('case 1: mark-sent status', resp1.status, 200);

    const supp1 = await suppCol.findOne({ customer_phone: PHONE });
    checkTrue('case 1: suppression doc exists', !!supp1);
    if (supp1) {
      check('case 1: failure_kind is contacted', supp1.failure_kind, 'contacted');
      checkTrue('case 1: contacted_at is set', supp1.contacted_at instanceof Date);
      const days = supp1.eligible_again_at
        ? (supp1.eligible_again_at.getTime() - Date.now()) / 86400000
        : null;
      checkTrue(
        `case 1: eligible_again_at ~180d out (got ${days === null ? 'null' : days.toFixed(4)}d)`,
        days !== null && Math.abs(days - 180) < 5 / 86400 // few seconds tolerance
      );
    }

    // --- Case 2: same phone, but this time it already had a legacy
    // (org_id: null) privacy suppression on record before delivery. Proves
    // recordContacted overwrites it in place — the delivered number leaves
    // the Failed list rather than gaining a duplicate document. ---
    await suppCol.deleteMany({ customer_phone: PHONE });
    await suppCol.insertOne({
      org_id: null,
      customer_phone: PHONE,
      failure_kind: 'privacy',
      status: 'active',
      first_failed_at: new Date(),
      last_failed_at: new Date(),
      last_failed_reason: 'legacy pre-multi-org privacy failure',
      retries_used: 0,
      next_retry_at: null,
      last_proposal_id: null,
      customer_name: null,
      follower: null,
      created_at: new Date(),
      updated_at: new Date(),
      resolved_at: null,
      contacted_at: null,
      eligible_again_at: null,
    });

    const proposal2 = makeProposal({});
    const ins2 = await proposalsCol.insertOne(proposal2);
    const id2 = ins2.insertedId;

    const resp2 = await fetch(`${BASE_URL}/crm/api/outreach/${id2}/mark-sent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AGENT_TOKEN}` },
      body: JSON.stringify({}),
    });
    check('case 2: mark-sent status', resp2.status, 200);

    const suppDocs2 = await suppCol.find({ customer_phone: PHONE }).toArray();
    check('case 2: exactly one suppression doc for phone (no duplicate)', suppDocs2.length, 1);
    if (suppDocs2.length >= 1) {
      check('case 2: failure_kind is now contacted (left the Failed list)', suppDocs2[0].failure_kind, 'contacted');
      checkTrue('case 2: contacted_at is set', suppDocs2[0].contacted_at instanceof Date);
    }

    // Cleanup.
    await proposalsCol.deleteMany({ customer_phone: PHONE });
    await suppCol.deleteMany({ customer_phone: PHONE });
  } finally {
    child.kill();
    await directClient.close();
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
