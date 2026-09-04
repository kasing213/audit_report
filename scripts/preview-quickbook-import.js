// Read-only preview: parses a target xlsx with the real import-parser, no DB writes.
// Usage: node scripts/preview-quickbook-import.js <path-to-xlsx>
const ExcelJS = require('exceljs');
const { parsePhoneWorkbook } = require('../dist/api/import-parser');

async function main() {
  const filePath = process.argv[2];
  if (!filePath) throw new Error('pass xlsx path');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  console.log(`Workbook: ${filePath}`);
  console.log(`Sheets (${wb.worksheets.length}): ${wb.worksheets.map((w) => w.name).join(', ')}\n`);

  const staleDateStr = new Date().toISOString().slice(0, 10);
  const result = parsePhoneWorkbook(wb, { staleDateStr });

  console.log(`usedFallback: ${result.usedFallback}`);
  console.log(
    `buckets: parsed=${result.buckets.parsed} invalid_format=${result.buckets.invalid_format} ` +
    `duplicate_in_file=${result.buckets.duplicate_in_file} already_in_db=${result.buckets.already_in_db} ` +
    `in_cooldown=${result.buckets.in_cooldown} net_new=${result.buckets.net_new}`
  );
  console.log(`sample rows (first 10 of ${result.rows.length}):`);
  console.log(JSON.stringify(result.rows.slice(0, 10), null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
