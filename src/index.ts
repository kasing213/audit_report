import { TelegrafBotService } from './bot/telegraf-bot';
import { ApiServer } from './api/server';
import { DailyScheduler } from './scheduler/daily-scheduler';
import { MonthlyScheduler } from './scheduler/monthly-scheduler';
import { PromiseScheduler } from './scheduler/promise-scheduler';
import { OutreachScheduler } from './scheduler/outreach-scheduler';
import { AdScannerScheduler } from './ad-scanner/ad-scanner-scheduler';
import { setOutreachAlertSender } from './outreach/outreach-alerts';
import { setInboundAlertSender } from './outreach/inbound-alerts';
import DatabaseConnection from './database/connection';
import { Logger } from './utils/logger';
import dotenv from 'dotenv';

dotenv.config();

async function main(): Promise<void> {
  try {
    Logger.info('Starting Audit Sales System...');
    Logger.info(`ENV check — DASHBOARD_TOKEN set: ${!!process.env.DASHBOARD_TOKEN}, all env keys: ${Object.keys(process.env).filter(k => !k.startsWith('npm_')).join(', ')}`);

    // Start API server first for health checks (non-blocking)
    Logger.info('Starting API server...');
    const port = parseInt(process.env.PORT || '3001', 10);
    const apiServer = new ApiServer(port);
    apiServer.start();
    Logger.info('API server started successfully');

    Logger.info('Connecting to database...');
    const db = DatabaseConnection.getInstance();
    await db.connect();
    Logger.info('Database connected successfully');

    Logger.info('Starting Telegram bot...');
    const telegramBot = new TelegrafBotService();
    await telegramBot.start();
    Logger.info('Telegram bot started successfully');

    // Setup audit daily report scheduler (consolidated view across all groups).
    // Per-group fanout was removed: only one rollup goes to AUDIT_CHAT_ID.
    const auditChatId = process.env.AUDIT_CHAT_ID || process.env.REPORT_CHAT_ID;
    if (auditChatId) {
      const auditDailyScheduler = new DailyScheduler(auditChatId);
      auditDailyScheduler.setSendReportCallback(async (chatId: string, buffer: Buffer, filename: string) => {
        await telegramBot.sendPhoto(chatId, buffer, filename);
      });
      auditDailyScheduler.startScheduler();
      Logger.info(`- Audit Daily Reports: Enabled (Audit Chat ID: ${auditChatId})`);

      // Setup monthly report scheduler
      const monthlyScheduler = new MonthlyScheduler(auditChatId);
      monthlyScheduler.setSendReportCallback(async (chatId: string, buffer: Buffer, filename: string, caption?: string) => {
        await telegramBot.sendDocument(chatId, buffer, filename, caption);
      });
      monthlyScheduler.startScheduler();
      Logger.info(`- Monthly Reports: Enabled (Audit Chat ID: ${auditChatId})`);
    } else {
      Logger.warn('AUDIT_CHAT_ID not set - audit daily and monthly reports disabled');
    }

    // Setup promise reminder scheduler
    const promiseScheduler = new PromiseScheduler();
    promiseScheduler.setSendMessageCallback(async (chatId: string, text: string, extra?: any) => {
      await telegramBot.sendMessage(chatId, text, extra);
    });
    promiseScheduler.startScheduler();
    Logger.info('- Promise Reminders: 8:00 AM daily');

    // Outreach alerts: register the bot sender so failed sends/lease-cap/worker
    // alerts can reach the audit chat. Always wired; the alert helper itself
    // bails if AUDIT_CHAT_ID isn't set.
    setOutreachAlertSender(async (chatId: string, text: string, extra?: any) => {
      await telegramBot.sendMessage(chatId, text, extra);
    });

    // Inbound replies: same bot, same sendMessage, separate registration so the
    // two alert channels can be tuned/throttled independently later.
    setInboundAlertSender(async (chatId: string, text: string, extra?: any) => {
      await telegramBot.sendMessage(chatId, text, extra);
    });

    // Outreach daily scan scheduler (off by default — gated on OUTREACH_AUTO_SCAN=true)
    const outreachScheduler = new OutreachScheduler();
    outreachScheduler.setNotifyCallback(async (chatId: string, text: string, extra?: any) => {
      await telegramBot.sendMessage(chatId, text, extra);
    });
    outreachScheduler.startScheduler();

    // Setup ad report PDF scanner
    const adReportChatId = process.env.AD_REPORT_CHAT_ID;
    if (adReportChatId && process.env.INTERNAL_BOT_TOKEN) {
      const adScanner = new AdScannerScheduler();
      adScanner.startScheduler();
      Logger.info(`- Ad PDF Scanner: 9:30 AM daily (Chat ID: ${adReportChatId})`);
    } else {
      Logger.warn('AD_REPORT_CHAT_ID or INTERNAL_BOT_TOKEN not set - ad scanner disabled');
    }

    Logger.info('Audit Sales System is running...');
    Logger.info('- Telegram Bot: Active (Commands: /help, /customers, /summary, /report)');
    Logger.info('- API Server: http://localhost:3001');

    if (auditChatId) {
      Logger.info('- Daily Reports: 11:59 PM → consolidated JPG to AUDIT_CHAT_ID');
      Logger.info('- Monthly Reports: 1st day 12:01 AM → Excel files');
    }

    process.on('SIGINT', async () => {
      Logger.info('Shutting down...');
      telegramBot.stop();
      await db.disconnect();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      Logger.info('Shutting down...');
      telegramBot.stop();
      await db.disconnect();
      process.exit(0);
    });

  } catch (error) {
    Logger.error('Failed to start application', error as Error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    Logger.error('Unhandled error in main', error);
    process.exit(1);
  });
}

export { main };