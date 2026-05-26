import * as cron from 'node-cron';
import { JpgReportGenerator } from '../reports/jpg-report';
import { Logger } from '../utils/logger';
import { ReportDataService } from '../reports/data-service';

export class DailyScheduler {
  private jpgGenerator: JpgReportGenerator;
  private dataService: ReportDataService;
  private telegramChatId: string;
  private groupId?: string;
  private groupName?: string;
  private sendReportCallback?: (chatId: string, buffer: Buffer, filename: string) => Promise<void>;

  constructor(telegramChatId: string, groupId?: string, groupName?: string) {
    this.jpgGenerator = new JpgReportGenerator();
    this.dataService = new ReportDataService();
    this.telegramChatId = telegramChatId;

    if (groupId !== undefined) {
      this.groupId = groupId;
    }

    if (groupName !== undefined) {
      this.groupName = groupName;
    }
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

      const groupInfo = this.groupId ? ` for ${this.groupName || this.groupId}` : '';
      Logger.info(`Generating scheduled daily report for ${dateString}${groupInfo}`);

      // Check if there are any sales reports from yesterday for this group
      const leadEvents = await this.dataService.getDailyLeadEvents(dateString, this.groupId);

      if (leadEvents.length === 0) {
        const noReportMsg = this.groupId
          ? `No sales report from yesterday (${dateString}) for ${this.groupName || this.groupId}`
          : `No sales report from yesterday (${dateString})`;
        Logger.warn(noReportMsg);
      } else {
        const foundMsg = this.groupId
          ? `Found ${leadEvents.length} sales case(s) for ${dateString} in ${this.groupName || this.groupId}`
          : `Found ${leadEvents.length} sales case(s) for ${dateString}`;
        Logger.info(foundMsg);
      }

      const reportBuffer = await this.jpgGenerator.generateDailyReport(dateString, this.groupId);
      const filename = this.groupId
        ? `daily-report-${dateString}-${this.groupId}.jpg`
        : `daily-report-${dateString}.jpg`;

      if (this.sendReportCallback) {
        await this.sendReportCallback(this.telegramChatId, reportBuffer, filename);
        const sentMsg = this.groupId
          ? `Daily report sent to ${this.groupName || this.groupId} chat: ${this.telegramChatId}`
          : `Daily report sent to Telegram chat: ${this.telegramChatId}`;
        Logger.info(sentMsg);
      } else {
        Logger.warn('No send report callback configured');
      }

    } catch (error) {
      Logger.error('Failed to generate/send daily report', error as Error);
    }
  }

  public startScheduler(): void {
    const enableDailyReports = process.env.ENABLE_DAILY_REPORTS;
    if (enableDailyReports && enableDailyReports.toLowerCase() === 'false') {
      const groupInfo = this.groupId ? ` for ${this.groupName || this.groupId}` : '';
      Logger.info(`Daily report scheduler disabled via ENABLE_DAILY_REPORTS=false${groupInfo}`);
      return;
    }

    // Schedule daily report at 10:00 AM Cambodia time, reporting yesterday's cases
    const reportTimezone = process.env.REPORT_TIMEZONE || 'Asia/Phnom_Penh';
    cron.schedule('0 10 * * *', () => {
      const groupInfo = this.groupId ? ` for ${this.groupName || this.groupId}` : '';
      Logger.info(`Daily report scheduled task triggered${groupInfo}`);
      this.generateAndSendDailyReport();
    }, {
      scheduled: true,
      timezone: reportTimezone
    });

    const groupInfo = this.groupId ? ` for ${this.groupName || this.groupId}` : '';
    Logger.info(`Daily report scheduler started - will send yesterday's report at 10:00 AM daily${groupInfo}`);
    Logger.info(`Timezone: ${reportTimezone}`);
    const chatInfo = this.groupId
      ? `Target ${this.groupName || this.groupId} chat ID: ${this.telegramChatId}`
      : `Target audit chat ID: ${this.telegramChatId}`;
    Logger.info(chatInfo);
  }

  public async sendManualReport(date?: string): Promise<void> {
    const targetDate = date || new Date().toISOString().split('T')[0];

    const groupInfo = this.groupId ? ` for ${this.groupName || this.groupId}` : '';
    Logger.info(`Generating manual daily report for ${targetDate}${groupInfo}`);

    try {
      const reportBuffer = await this.jpgGenerator.generateDailyReport(targetDate, this.groupId);
      const filename = this.groupId
        ? `daily-report-${targetDate}-${this.groupId}.jpg`
        : `daily-report-${targetDate}.jpg`;

      if (this.sendReportCallback) {
        await this.sendReportCallback(this.telegramChatId, reportBuffer, filename);
        const sentMsg = this.groupId
          ? `Manual daily report sent for ${targetDate} to ${this.groupName || this.groupId}`
          : `Manual daily report sent for ${targetDate}`;
        Logger.info(sentMsg);
      } else {
        Logger.warn('No send report callback configured');
      }
    } catch (error) {
      Logger.error('Failed to send manual report', error as Error);
      throw error;
    }
  }
}