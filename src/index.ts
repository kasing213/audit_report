import { TelegrafBotService } from './bot/telegraf-bot';
import { ApiServer } from './api/server';
import { DailyScheduler } from './scheduler/daily-scheduler';
import { MonthlyScheduler } from './scheduler/monthly-scheduler';
import DatabaseConnection from './database/connection';
import { Logger } from './utils/logger';
import dotenv from 'dotenv';

dotenv.config();

async function main(): Promise<void> {
  try {
    Logger.info('Starting Audit Sales System...');

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

    // Setup daily report scheduler
    const auditChatId = process.env.AUDIT_CHAT_ID || process.env.REPORT_CHAT_ID;
    if (auditChatId) {
      const dailyScheduler = new DailyScheduler(auditChatId);
      dailyScheduler.setSendReportCallback(async (chatId: string, buffer: Buffer, filename: string) => {
        await telegramBot.sendPhoto(chatId, buffer, filename);
      });
      dailyScheduler.startScheduler();
      Logger.info(`- Daily Reports: Enabled (Audit Chat ID: ${auditChatId})`);

      // Setup monthly report scheduler
      const monthlyScheduler = new MonthlyScheduler(auditChatId);
      monthlyScheduler.setSendReportCallback(async (chatId: string, buffer: Buffer, filename: string, caption?: string) => {
        await telegramBot.sendDocument(chatId, buffer, filename, caption);
      });
      monthlyScheduler.startScheduler();
      Logger.info(`- Monthly Reports: Enabled (Audit Chat ID: ${auditChatId})`);
    } else {
      Logger.warn('AUDIT_CHAT_ID not set - daily and monthly reports disabled');
    }

    Logger.info('Audit Sales System is running...');
    Logger.info('- Telegram Bot: Active (Commands: /help, /customers, /report)');
    Logger.info('- API Server: http://localhost:3001');
    if (auditChatId) {
      Logger.info('- Daily Reports: 11:59 PM → JPG images');
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