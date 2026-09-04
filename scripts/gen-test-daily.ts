/**
 * Generate the daily JPG report for a list of dates into testing_daily/,
 * WITHOUT sending to Telegram. Used for diagnosing the daily-report pipeline.
 *
 *   npx ts-node scripts/gen-test-daily.ts 2026-05-27 2026-05-28
 */
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs/promises';
import DatabaseConnection from '../src/database/connection';
import { JpgReportGenerator } from '../src/reports/jpg-report';
import { ReportDataService } from '../src/reports/data-service';

dotenv.config();

async function main(): Promise<void> {
  const dates = process.argv.slice(2);
  if (dates.length === 0) {
    dates.push(new Date().toISOString().split('T')[0]);
  }

  const outDir = path.join(__dirname, '..', 'testing_daily');
  await fs.mkdir(outDir, { recursive: true });
  console.log(`Output dir: ${outDir}`);
  console.log(`Dates: ${dates.join(', ')}`);

  const db = DatabaseConnection.getInstance();
  await db.connect();

  const generator = new JpgReportGenerator();
  const dataService = new ReportDataService();

  const reportTimezone = process.env.REPORT_TIMEZONE || 'Asia/Phnom_Penh';

  for (const date of dates) {
    // OLD path: by occurrence date (what was producing empty reports)
    const byDate = await dataService.getDailyLeadEvents(date);
    // NEW path: by entry day (created_at window) — what the scheduler now uses
    const byEntry = await dataService.getLeadEventsByEntryDay(date, undefined, reportTimezone);
    console.log(`\n[${date}] byDate=${byDate.length} | byEntryDay=${byEntry.length} lead event(s)`);
    for (const e of byEntry) {
      console.log(
        `  - ${e.customer?.phone || '?'} | ${e.follower || '?'} | ${e.page || '?'} | status=${e.status_text || '-'} reason=${e.reason_code || '-'}`
      );
    }

    const buf = await generator.generateDailyReport(date, undefined, { byEntryDay: true, timezone: reportTimezone });
    const file = path.join(outDir, `daily-report-${date}.jpg`);
    await fs.writeFile(file, buf);
    console.log(`  -> wrote ${file} (${buf.length} bytes)`);
  }

  await db.disconnect();
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
