import * as cron from 'node-cron';
import { JpgReportGenerator } from '../reports/jpg-report';
import { Logger } from '../utils/logger';

export class DailyScheduler {
  private jpgGenerator: JpgReportGenerator;
  private telegramChatId: string;
  private sendReportCallback?: (chatId: string, buffer: Buffer, filename: string) => Promise<void>;

  constructor(telegramChatId: string) {
    this.jpgGenerator = new JpgReportGenerator();
    this.telegramChatId = telegramChatId;
  }

  public setSendReportCallback(callback: (chatId: string, buffer: Buffer, filename: string) => Promise<void>): void {
    this.sendReportCallback = callback;
  }

  private async generateAndSendDailyReport(): Promise<void> {
    try {
      // Get yesterday's date (since we're running at end of day)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dateString = yesterday.toISOString().split('T')[0]; // YYYY-MM-DD format

      Logger.info(`Generating scheduled daily report for ${dateString}`);

      const reportBuffer = await this.jpgGenerator.generateDailyReport(dateString);
      const filename = `daily-report-${dateString}.jpg`;

      if (this.sendReportCallback) {
        await this.sendReportCallback(this.telegramChatId, reportBuffer, filename);
        Logger.info(`Daily report sent to Telegram chat: ${this.telegramChatId}`);
      } else {
        Logger.warn('No send report callback configured');
      }

    } catch (error) {
      Logger.error('Failed to generate/send daily report', error as Error);
    }
  }

  public startScheduler(): void {
    // Schedule daily report at 11:59 PM (23:59)
    cron.schedule('59 23 * * *', () => {
      Logger.info('Daily report scheduled task triggered');
      this.generateAndSendDailyReport();
    }, {
      scheduled: true,
      timezone: process.env.TIMEZONE || 'Asia/Kuala_Lumpur'
    });

    Logger.info('Daily report scheduler started - will send reports at 11:59 PM daily');
    Logger.info(`Timezone: ${process.env.TIMEZONE || 'Asia/Kuala_Lumpur'}`);
    Logger.info(`Target chat ID: ${this.telegramChatId}`);
  }

  public async sendManualReport(date?: string): Promise<void> {
    const targetDate = date || new Date().toISOString().split('T')[0];

    Logger.info(`Generating manual daily report for ${targetDate}`);

    try {
      const reportBuffer = await this.jpgGenerator.generateDailyReport(targetDate);
      const filename = `daily-report-${targetDate}.jpg`;

      if (this.sendReportCallback) {
        await this.sendReportCallback(this.telegramChatId, reportBuffer, filename);
        Logger.info(`Manual daily report sent for ${targetDate}`);
      } else {
        Logger.warn('No send report callback configured');
      }
    } catch (error) {
      Logger.error('Failed to send manual report', error as Error);
      throw error;
    }
  }
}