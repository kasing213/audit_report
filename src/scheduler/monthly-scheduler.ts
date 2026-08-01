import * as cron from 'node-cron';
import { ExcelReportGenerator } from '../reports/excel-report';
import { Logger } from '../utils/logger';

export class MonthlyScheduler {
  private excelGenerator: ExcelReportGenerator;
  private auditChatId: string;
  private sendReportCallback?: (chatId: string, buffer: Buffer, filename: string, caption?: string) => Promise<void>;

  constructor(auditChatId: string) {
    this.excelGenerator = new ExcelReportGenerator();
    this.auditChatId = auditChatId;
  }

  public setSendReportCallback(callback: (chatId: string, buffer: Buffer, filename: string, caption?: string) => Promise<void>): void {
    this.sendReportCallback = callback;
  }

  private async generateAndSendMonthlyReport(): Promise<void> {
    try {
      // Get previous month's date
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const year = lastMonth.getFullYear();
      const month = lastMonth.getMonth() + 1;
      const monthString = `${year}-${String(month).padStart(2, '0')}`;
      const monthName = lastMonth.toLocaleString('default', { month: 'long', year: 'numeric' });

      Logger.info(`Generating scheduled monthly report for ${monthString} (${monthName})`);

      const { buffer: reportBuffer, followers } = await this.excelGenerator.generateMonthlyReport(year, month);
      const filename = `monthly-report-${monthString}.xlsx`;

      const followerList = followers.length > 0
        ? followers.map(f => `• ${f}`).join('\n')
        : '• No follower data';

      const caption = [
        `📊 *Automated Monthly Report - ${monthName}*`,
        '',
        `📋 *${followers.length} Follower(s):*`,
        followerList,
        '',
        `📅 Generated: ${new Date().toLocaleString()}`,
        '🤖 Automated monthly delivery',
        '',
        '💡 For other months, use `/report YYYY-MM` command'
      ].join('\n');

      if (this.sendReportCallback) {
        await this.sendReportCallback(this.auditChatId, reportBuffer, filename, caption);
        Logger.info(`Monthly report sent to audit chat: ${this.auditChatId} for ${monthString}`);
      } else {
        Logger.warn('No send report callback configured for monthly scheduler');
      }

    } catch (error) {
      Logger.error('Failed to generate/send monthly report', error as Error);
    }
  }

  public startScheduler(): void {
    // Check if monthly reports are enabled
    const enableMonthlyReports = process.env.ENABLE_MONTHLY_REPORTS;
    if (enableMonthlyReports && enableMonthlyReports.toLowerCase() === 'false') {
      Logger.info('Monthly report scheduler disabled via ENABLE_MONTHLY_REPORTS=false');
      return;
    }

    // Schedule monthly report on 1st day of month at 12:01 AM (00:01)
    cron.schedule('1 0 1 * *', () => {
      Logger.info('Monthly report scheduled task triggered');
      this.generateAndSendMonthlyReport();
    }, {
      scheduled: true,
      timezone: process.env.TIMEZONE || 'Asia/Phnom_Penh'
    });

    Logger.info('Monthly report scheduler started - will send reports on 1st day at 12:01 AM');
    Logger.info(`Timezone: ${process.env.TIMEZONE || 'Asia/Phnom_Penh'}`);
    Logger.info(`Target audit chat ID: ${this.auditChatId}`);
  }

  public async sendManualReport(monthString?: string): Promise<void> {
    try {
      let targetMonth: string;
      let year: number;
      let month: number;

      if (monthString && /^\d{4}-\d{2}$/.test(monthString)) {
        targetMonth = monthString;
        [year, month] = monthString.split('-').map(Number);
      } else {
        // Default to previous month
        const now = new Date();
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        year = lastMonth.getFullYear();
        month = lastMonth.getMonth() + 1;
        targetMonth = `${year}-${String(month).padStart(2, '0')}`;
      }

      Logger.info(`Generating manual monthly report for ${targetMonth}`);

      const { buffer: reportBuffer, followers } = await this.excelGenerator.generateMonthlyReport(year, month);
      const filename = `monthly-report-${targetMonth}.xlsx`;

      const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long', year: 'numeric' });
      const followerList = followers.length > 0
        ? followers.map(f => `• ${f}`).join('\n')
        : '• No follower data';

      const caption = [
        `📊 *Manual Monthly Report - ${monthName}*`,
        '',
        `📋 *${followers.length} Follower(s):*`,
        followerList,
        '',
        `📅 Generated: ${new Date().toLocaleString()}`,
        '👤 Manual request'
      ].join('\n');

      if (this.sendReportCallback) {
        await this.sendReportCallback(this.auditChatId, reportBuffer, filename, caption);
        Logger.info(`Manual monthly report sent for ${targetMonth}`);
      } else {
        Logger.warn('No send report callback configured');
      }
    } catch (error) {
      Logger.error('Failed to send manual monthly report', error as Error);
      throw error;
    }
  }
}