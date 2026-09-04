/**
 * One-off: generate the consolidated daily JPG report for a range of dates
 * and push each to the audit group via Telegram.
 *
 * Usage:
 *   npx ts-node scripts/push-daily-reports.ts 2026-05-20 2026-05-22
 *   (defaults to the AUDIT_CHAT_ID from .env)
 */
import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import DatabaseConnection from '../src/database/connection';
import { JpgReportGenerator } from '../src/reports/jpg-report';
import { ReportDataService } from '../src/reports/data-service';

dotenv.config();

function datesInRange(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (d <= last) {
    out.push(d.toISOString().split('T')[0]);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function main(): Promise<void> {
  const start = process.argv[2] || '2026-05-20';
  const end = process.argv[3] || '2026-05-22';
  const chatId = process.env.AUDIT_CHAT_ID || process.env.REPORT_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!chatId) throw new Error('AUDIT_CHAT_ID not set');
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

  const dates = datesInRange(start, end);
  console.log(`Pushing reports for ${dates.join(', ')} -> chat ${chatId}`);

  const db = DatabaseConnection.getInstance();
  await db.connect();

  const bot = new Telegraf(token);
  const generator = new JpgReportGenerator();
  const dataService = new ReportDataService();

  for (const date of dates) {
    const events = await dataService.getDailyLeadEvents(date);
    const buffer = await generator.generateDailyReport(date);
    const filename = `daily-report-${date}.jpg`;

    await bot.telegram.sendPhoto(chatId, { source: buffer, filename }, {
      caption: `📊 DAILY REPORT — ${date}\nCases: ${events.length}\n\nGenerated: ${new Date().toLocaleString()}`
    });
    console.log(`[sent] ${date} (${events.length} case(s))`);
  }

  await db.disconnect();
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
