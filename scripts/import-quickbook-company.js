// One-off import: multi-sheet QuickBook phone-number export -> company org
// customer DB, staged as PENDING outreach proposals (still requires manual
// approval on /crm/outreach before anything sends).
//
// Deliberately does NOT boot the full app (no Express, no Telegram bot poller,
// no cron schedulers) — just the DB connection + repositories, so it can't
// collide with the already-running production instance.
//
// Two-step (safe by default):
//   node scripts/import-quickbook-company.js <path-to-xlsx>            # dry-run, shows buckets
//   node scripts/import-quickbook-company.js <path-to-xlsx> --confirm  # actually import + stage
//
// DATABASE_URL is read from the repo-root .env.
const path = require('path');
const ExcelJS = require('exceljs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { parsePhoneWorkbook } = require('../dist/api/import-parser');
const { toInternationalPhone } = require('../dist/utils/phone-utils');
const DatabaseConnection = require('../dist/database/connection').default;
const { SalesCaseRepository } = require('../dist/database/repository');
const { OutreachSuppressionRepository } = require('../dist/outreach/outreach-suppression-repository');
const { generateBatch } = require('../dist/outreach/outreach-agent');

const ORG_ID = 'company';

async function main() {
  const filePath = process.argv[2];
  const confirm = process.argv.includes('--confirm');
  if (!filePath) {
    console.error('Usage: node scripts/import-quickbook-company.js <path-to-xlsx> [--confirm]');
    process.exit(1);
  }

  await DatabaseConnection.getInstance().connect();
  const repository = new SalesCaseRepository();

  const suppressedPhones = await new OutreachSuppressionRepository().getSuppressedPhones(ORG_ID);
  const existingPhones = new Set(
    (await repository.getAllCustomers(undefined, ORG_ID))
      .filter((c) => c.phone)
      .map((c) => toInternationalPhone(c.phone.trim()))
  );
  console.log(`Company org: ${existingPhones.size} existing customers, ${suppressedPhones.size} suppressed phones.`);

  const STALE_DAYS = 45; // matches DEFAULT_STALE_DAYS in outreach-agent.ts
  const staleDate = new Date();
  staleDate.setDate(staleDate.getDate() - STALE_DAYS);
  const staleDateStr = staleDate.toISOString().slice(0, 10);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  console.log(`\nWorkbook: ${filePath}`);
  console.log(`Sheets (${wb.worksheets.length}): ${wb.worksheets.map((w) => w.name).join(', ')}`);

  const { rows, buckets, usedFallback } = parsePhoneWorkbook(wb, {
    staleDateStr,
    existingPhones,
    suppressedPhones,
  });

  console.log(`\nusedFallback: ${usedFallback}`);
  console.log(
    `buckets: parsed=${buckets.parsed} invalid_format=${buckets.invalid_format} ` +
    `duplicate_in_file=${buckets.duplicate_in_file} already_in_db=${buckets.already_in_db} ` +
    `in_cooldown=${buckets.in_cooldown} net_new=${buckets.net_new}`
  );
  console.log(`\n${rows.length} row(s) will be imported + staged for outreach approval.`);
  console.log('Sample (first 5):');
  console.log(JSON.stringify(rows.slice(0, 5), null, 2));

  if (!confirm) {
    console.log('\nDRY RUN — no changes made.');
    console.log('Re-run with --confirm to actually import + stage outreach proposals:');
    console.log(`  node scripts/import-quickbook-company.js "${filePath}" --confirm`);
    await DatabaseConnection.getInstance().disconnect();
    return;
  }

  if (rows.length === 0) {
    console.log('\nNothing net-new to import.');
    await DatabaseConnection.getInstance().disconnect();
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const leadEvents = rows.map((row) => ({
    date: row.date || today,
    org_id: ORG_ID,
    customer: { name: row.name || null, phone: row.phone },
    page: row.page || null,
    destination: row.destination || null,
    follower: row.follower || null,
    status_text: null,
    reason_code: row.reason_code || null,
    note: row.note || null,
    promise_date: row.promise_date || null,
    promise_status: row.promise_date ? 'pending' : null,
    group_id: null,
    source: { telegram_msg_id: 'csv-import', model: 'csv-import' },
    created_at: new Date(),
  }));

  await repository.saveLeadEvents(leadEvents);
  console.log(`\nInserted ${leadEvents.length} lead event(s) into leads_events (org=${ORG_ID}).`);

  const phones = rows.map((r) => r.phone);
  const generation = await generateBatch({ phones, limit: phones.length, orgId: ORG_ID });
  console.log(
    `Staged outreach: created=${generation.created} skipped=${generation.skipped} errored=${generation.errored} ` +
    `(requested=${generation.requested})`
  );

  await repository.logAudit({
    timestamp: new Date(),
    action: 'csv-import-outreach',
    message_id: 0,
    user_id: 0,
    username: 'script:import-quickbook-company',
    original_message: `Imported ${leadEvents.length} records from ${path.basename(filePath)} and staged ${generation.created} outreach proposals`,
    parsed_result: { imported: leadEvents.length, staged: generation.created, staged_skipped: generation.skipped },
  });

  console.log('\nDone. Review staged proposals at /crm/outreach before approving.');
  await DatabaseConnection.getInstance().disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
