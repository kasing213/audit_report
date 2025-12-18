import { TelegrafBotService } from './bot/telegraf-bot';
import { ApiServer } from './api/server';
import { DailyScheduler } from './scheduler/daily-scheduler';
import DatabaseConnection from './database/connection';
import { Logger } from './utils/logger';
import dotenv from 'dotenv';

dotenv.config();

async function main(): Promise<void> {
  try {
    Logger.info('Starting Audit Sales System...');

    Logger.info('Connecting to database...');
    const db = DatabaseConnection.getInstance();
    await db.connect();
    Logger.info('Database connected successfully');

    Logger.info('Starting Telegram bot...');
    const telegramBot = new TelegrafBotService();
    await telegramBot.start();
    Logger.info('Telegram bot started successfully');

    Logger.info('Starting API server...');
    const apiServer = new ApiServer(3001);
    apiServer.start();

    // Setup daily report scheduler
    const reportChatId = process.env.REPORT_CHAT_ID;
    if (reportChatId) {
      const scheduler = new DailyScheduler(reportChatId);
      scheduler.setSendReportCallback(async (chatId: string, buffer: Buffer, filename: string) => {
        await telegramBot.sendPhoto(chatId, buffer, filename);
      });
      scheduler.startScheduler();
      Logger.info(`- Daily Reports: Enabled (Chat ID: ${reportChatId})`);
    } else {
      Logger.warn('REPORT_CHAT_ID not set - daily reports disabled');
    }

    Logger.info('Audit Sales System is running...');
    Logger.info('- Telegram Bot: Active');
    Logger.info('- API Server: http://localhost:3001');

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