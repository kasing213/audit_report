require('./check-db').useScratchDb();

/**
 * Verifies the QuickBook-only targeting filter (2026-08-01 spec: outreach
 * failure taxonomy + QuickBook-only design): buildStaleCustomersPipeline
 * (used by both the CRM stale-customers report and outreach candidate
 * selection, via getStaleCustomers -> outreach-agent.ts selectCandidates)
 * only returns phones with at least one lead event whose source.model is
 * 'csv-import' — the QuickBook/spreadsheet import. A phone whose only source
 * is 'bulk-telegram' (Telegram-decoded or worker-written) must never surface,
 * even though it is otherwise stale.
 *
 * Usage: node scripts/check-quickbook-only.js
 *
 * Runs against a scratch database (Audit_check on the same cluster), never
 * production `Audit` — see scripts/check-db.js.
 */
const { MongoClient } = require('mongodb');

const PHONE_CSV = '+855999000777';       // has a csv-import event -> must appear
const PHONE_TELEGRAM = '+855999000888';  // bulk-telegram only -> must never appear
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

  const leadsEvents = db.collection('leads_events');
  await leadsEvents.deleteMany({ 'customer.phone': { $in: [PHONE_CSV, PHONE_TELEGRAM] } });

  // Both stale — well past any plausible days-threshold.
  const OLD_DATE = '2025-01-01';

  await leadsEvents.insertOne({
    org_id: 'company',
    date: OLD_DATE,
    customer: { name: 'Csv Customer', phone: PHONE_CSV },
    page: 'Facebook',
    follower: 'Alice',
    status_text: 'interested',
    reason_code: null,
    deleted: false,
    source: { telegram_msg_id: 'chk-csv-1', model: 'csv-import' },
    created_at: new Date(OLD_DATE),
  });

  await leadsEvents.insertOne({
    org_id: 'company',
    date: OLD_DATE,
    customer: { name: 'Telegram Customer', phone: PHONE_TELEGRAM },
    page: 'Facebook',
    follower: 'Bob',
    status_text: 'interested',
    reason_code: null,
    deleted: false,
    source: { telegram_msg_id: 'chk-tg-1', model: 'bulk-telegram' },
    created_at: new Date(OLD_DATE),
  });

  const DatabaseConnection = require('../dist/database/connection').default;
  await DatabaseConnection.getInstance().connect();
  const { SalesCaseRepository } = require('../dist/database/repository');
  const repo = new SalesCaseRepository();

  // getStaleCustomers has three callers: the /crm bot command, the CRM
  // dashboard stale view, and outreach candidate selection. Only OUTREACH is
  // meant to be QuickBook-only — filtering unconditionally would silently hide
  // Telegram-sourced customers from the operator's own reports.
  const crm = (await repo.getStaleCustomers(14, undefined, 'company')).map((c) => c.phone);
  check('CRM default: csv-import phone appears', crm.includes(PHONE_CSV), true);
  check('CRM default: bulk-telegram phone STILL appears (reporting unchanged)',
    crm.includes(PHONE_TELEGRAM), true);

  const outreach = (await repo.getStaleCustomers(14, undefined, 'company', { quickBookOnly: true }))
    .map((c) => c.phone);
  check('outreach: csv-import phone appears', outreach.includes(PHONE_CSV), true);
  check('outreach: bulk-telegram-only phone never appears', outreach.includes(PHONE_TELEGRAM), false);

  await leadsEvents.deleteMany({ 'customer.phone': { $in: [PHONE_CSV, PHONE_TELEGRAM] } });
  await client.close();
  await DatabaseConnection.getInstance().disconnect();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
