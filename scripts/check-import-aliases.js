/**
 * Verifies the REAL exported parser (dist/api/import-parser.js), not a
 * re-implementation of the alias/dedup rule. Proves two paths:
 *
 *   1. The aliased structured path: a sheet headed "Phone Number" (not the
 *      literal "phone") is detected, the "No." index column is skipped, and
 *      duplicates within the file are bucketed correctly.
 *   2. The header-less fallback path: a sheet with no phone-ish header still
 *      routes to the QuickBook free-text parser (extractQuickBookRecord),
 *      unchanged from its original behavior.
 *
 * parsePhoneSheet is pure (no DB/network I/O) — this script never touches a
 * database, so there is nothing to redirect via check-db.js.
 *
 * Usage: node scripts/check-import-aliases.js <path-to-xlsx>
 */
const ExcelJS = require('exceljs');
const { parsePhoneSheet, readHeaders, hasPhoneColumn } = require('../dist/api/import-parser');

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

async function checkRealFile(path) {
  console.log(`\n--- Path 1: structured "Phone Number" sheet (${path}) ---`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];

  const headers = readHeaders(ws);
  check('phone column detected via alias ("phone number")', hasPhoneColumn(headers), true);
  check('index column present as first header ("no.")', headers[0], 'no.');

  const staleDateStr = '2025-01-01';
  const result = parsePhoneSheet(ws, { staleDateStr });

  console.log(
    `parsed=${result.buckets.parsed} invalid_format=${result.buckets.invalid_format} ` +
    `duplicate_in_file=${result.buckets.duplicate_in_file} already_in_db=${result.buckets.already_in_db} ` +
    `in_cooldown=${result.buckets.in_cooldown} net_new=${result.buckets.net_new}`
  );

  check('usedFallback is false', result.usedFallback, false);
  check('100 rows parsed', result.buckets.parsed, 100);
  check('0 invalid format', result.buckets.invalid_format, 0);
  check('3 duplicates within file', result.buckets.duplicate_in_file, 3);
  check('0 already_in_db (no exclusion sets passed)', result.buckets.already_in_db, 0);
  check('0 in_cooldown (no exclusion sets passed)', result.buckets.in_cooldown, 0);
  check('97 net_new', result.buckets.net_new, 97);
  check('97 output rows', result.rows.length, 97);
  check('output row has index column dropped ("no." key absent)', result.rows.every((r) => !('no.' in r)), true);
  check('output row phone is E.164', result.rows.every((r) => /^\+855\d{8,9}$/.test(r.phone)), true);
  check('output row date backdated to staleDateStr', result.rows.every((r) => r.date === staleDateStr), true);

  // Exclusion sets: prove already_in_db / in_cooldown buckets actually work
  // against the caller-supplied sets (this is the whole point of keeping the
  // parser pure — the route fetches these; here we fake two of the 97 unique
  // numbers as already known).
  const firstTwo = result.rows.slice(0, 2).map((r) => r.phone);
  const result2 = parsePhoneSheet(ws, {
    staleDateStr,
    existingPhones: new Set([firstTwo[0]]),
    suppressedPhones: new Set([firstTwo[1]]),
  });
  check('already_in_db bucket honors existingPhones param', result2.buckets.already_in_db, 1);
  check('in_cooldown bucket honors suppressedPhones param', result2.buckets.in_cooldown, 1);
  check('net_new shrinks by the 2 excluded numbers', result2.buckets.net_new, 95);
}

async function checkFallbackPath() {
  console.log('\n--- Path 2: header-less QuickBook free-text fallback (in-memory fixture) ---');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('QuickBook Export');
  // No header row with recognisable phone/index columns — first row is data,
  // exactly like a raw QuickBook report dump. Row 1 is skipped by convention
  // (treated as a potential title row), so put real data from row 2.
  ws.addRow(['Title Row (skipped)']);
  ws.addRow(['060-Pkarikkongsuon 092 462911']);
  ws.addRow(['6. Sokha 077123456']);
  ws.addRow(['no phone number here']); // rejected — no digit run
  ws.addRow(['012-Vanna 011 987 654']);

  const headers = readHeaders(ws);
  check('no phone column detected (header-less sheet)', hasPhoneColumn(headers), false);

  const staleDateStr = '2025-06-16';
  const result = parsePhoneSheet(ws, { staleDateStr });

  check('usedFallback is true', result.usedFallback, true);
  check('fallback: 3 rows parsed (rejects the no-phone row)', result.buckets.parsed, 3);
  check('fallback: 3 net_new (fallback never checks already_in_db/in_cooldown)', result.buckets.net_new, 3);
  check('fallback: 0 already_in_db', result.buckets.already_in_db, 0);
  check('fallback: 0 in_cooldown', result.buckets.in_cooldown, 0);
  check('fallback: 3 output rows', result.rows.length, 3);
  check('fallback: name extracted for row 1', result.rows[0].name, 'Pkarikkongsuon');
  check('fallback: phone extracted+normalised for row 1', result.rows[0].phone, '+85592462911');
  check('fallback: name extracted for row 2', result.rows[1].name, 'Sokha');
  check('fallback: phone extracted+normalised for row 2', result.rows[1].phone, '+85577123456');
  check('fallback: name extracted for row 3', result.rows[2].name, 'Vanna');
  check('fallback: phone extracted+normalised for row 3', result.rows[2].phone, '+85511987654');
  check('fallback: dates backdated to staleDateStr', result.rows.every((r) => r.date === staleDateStr), true);
}

(async () => {
  const path = process.argv[2];
  if (!path) throw new Error('pass the xlsx path');

  await checkRealFile(path);
  await checkFallbackPath();

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
