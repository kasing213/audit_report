/**
 * One-off: re-send corrected daily reports keyed on ENTRY day (created_at,
 * Cambodia time) for a set of dates, skipping days with no entries.
 *   npx ts-node scripts/resend-entry-day-reports.ts 2026-05-19 2026-05-21 ...
 */
import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import DatabaseConnection from '../src/database/connection';
import { JpgReportGenerator } from '../src/reports/jpg-report';
import { ReportDataService } from '../src/reports/data-service';

dotenv.config();

async function main(): Promise<void> {
  const dates = process.argv.slice(2);
  const chatId = process.env.AUDIT_CHAT_ID || process.env.REPORT_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const tz = process.env.REPORT_TIMEZONE || 'Asia/Phnom_Penh';
  if (!chatId) throw new Error('AUDIT_CHAT_ID not set');
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');
  if (dates.length === 0) throw new Error('Pass one or more YYYY-MM-DD dates');

  const db = DatabaseConnection.getInstance();
  await db.connect();
  const bot = new Telegraf(token);
  const generator = new JpgReportGenerator();
  const dataService = new ReportDataService();

  for (const date of dates) {
    const events = await dataService.getLeadEventsByEntryDay(date, undefined, tz);
    if (events.length === 0) {
      console.log(`[skip] ${date} (0 entries)`);
      continue;
    }
    const buffer = await generator.generateDailyReport(date, undefined, { byEntryDay: true, timezone: tz });
    const filename = `daily-report-${date}.jpg`;
    await bot.telegram.sendPhoto(chatId, { source: buffer, filename }, {
      caption: `📊 DAILY REPORT (corrected re-send)\nSales entries logged on ${date}\nCases: ${events.length}`
    });
    console.log(`[sent] ${date} (${events.length} case(s))`);
  }

  await db.disconnect();
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
