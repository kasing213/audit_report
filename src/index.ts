import { TelegrafBotService } from './bot/telegraf-bot';
import { ApiServer } from './api/server';
import { DailyScheduler } from './scheduler/daily-scheduler';
import { MonthlyScheduler } from './scheduler/monthly-scheduler';
import { PromiseScheduler } from './scheduler/promise-scheduler';
import { AdScannerScheduler } from './ad-scanner/ad-scanner-scheduler';
import DatabaseConnection from './database/connection';
import { Logger } from './utils/logger';
import { GroupConfigManager } from './utils/group-config';
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

    // Setup daily report schedulers for sales groups
    const groupConfigManager = GroupConfigManager.getInstance();
    const activeGroups = groupConfigManager.getAllActiveGroups();
    const dailySchedulers: DailyScheduler[] = [];

    if (activeGroups.length > 0) {
      Logger.info(`Setting up daily schedulers for ${activeGroups.length} sales group(s):`);

      for (const group of activeGroups) {
        const groupScheduler = new DailyScheduler(group.chatId, group.groupId, group.name);
        groupScheduler.setSendReportCallback(async (chatId: string, buffer: Buffer, filename: string) => {
          await telegramBot.sendPhoto(chatId, buffer, filename);
        });
        groupScheduler.startScheduler();
        dailySchedulers.push(groupScheduler);
        Logger.info(`- ${group.name} (${group.groupId}): Chat ID ${group.chatId}`);
      }
    } else {
      Logger.warn('No sales group chat IDs configured - group-specific daily reports disabled');
    }

    // Setup audit daily report scheduler (consolidated view)
    const auditChatId = process.env.AUDIT_CHAT_ID || process.env.REPORT_CHAT_ID;
    if (auditChatId) {
      const auditDailyScheduler = new DailyScheduler(auditChatId);
      auditDailyScheduler.setSendReportCallback(async (chatId: string, buffer: Buffer, filename: string) => {
        await telegramBot.sendPhoto(chatId, buffer, filename);
      });
      auditDailyScheduler.startScheduler();
      dailySchedulers.push(auditDailyScheduler);
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

    const totalSchedulers = activeGroups.length + (auditChatId ? 1 : 0);
    if (totalSchedulers > 0) {
      Logger.info(`- Daily Reports: 11:59 PM → JPG images (${totalSchedulers} scheduler(s))`);
      if (activeGroups.length > 0) {
        Logger.info(`  • ${activeGroups.length} group-specific reports`);
      }
      if (auditChatId) {
        Logger.info('  • 1 consolidated audit report');
      }
    }

    if (auditChatId) {
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