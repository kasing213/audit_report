import * as cron from 'node-cron';
import { JpgReportGenerator } from '../reports/jpg-report';
import { Logger } from '../utils/logger';
import { getDateNDaysAgo, getTodayDate } from '../utils/time';

export class DailyScheduler {
  private jpgGenerator: JpgReportGenerator;
  private telegramChatId: string;
  private groupId?: string;
  private groupName?: string;
  private sendReportCallback?: (chatId: string, buffer: Buffer, filename: string, caption?: string) => Promise<void>;

  constructor(telegramChatId: string, groupId?: string, groupName?: string) {
    this.jpgGenerator = new JpgReportGenerator();
    this.telegramChatId = telegramChatId;

    if (groupId !== undefined) {
      this.groupId = groupId;
    }

    if (groupName !== undefined) {
      this.groupName = groupName;
    }
  }

  public setSendReportCallback(callback: (chatId: string, buffer: Buffer, filename: string, caption?: string) => Promise<void>): void {
    this.sendReportCallback = callback;
  }

  /**
   * One photo per follower (split into parts when long) for entries logged on
   * `dateString`. Followers with no entries get nothing.
   */
  private async sendFollowerReports(dateString: string, reportTimezone: string): Promise<number> {
    const images = await this.jpgGenerator.generateFollowerDailyReports(dateString, reportTimezone);
    if (images.length === 0) {
      Logger.warn(`No staff sales entries made on ${dateString}; no daily images sent`);
      return 0;
    }
    if (!this.sendReportCallback) {
      Logger.warn('No send report callback configured');
      return 0;
    }
    let sent = 0;
    for (const img of images) {
      try {
        await this.sendReportCallback(this.telegramChatId, img.buffer, img.filename, img.caption);
        sent++;
      } catch (error) {
        // One rejected photo must not stop the other followers' reports.
        Logger.error(`Failed to send daily report image ${img.filename}`, error as Error);
      }
    }
    Logger.info(`Daily report: sent ${sent}/${images.length} image(s) for ${dateString} to chat ${this.telegramChatId}`);
    return sent;
  }

  private async generateAndSendDailyReport(): Promise<void> {
    try {
      // Report covers everything ENTERED during yesterday's calendar day in
      // report-timezone (Cambodia). Staff log a day's cases over the following
      // days, so keying on entry day (created_at) — not the case's own date —
      // means the 10 AM report is complete and never empty at send time.
      const reportTimezone = process.env.REPORT_TIMEZONE || 'Asia/Phnom_Penh';
      const dateString = getDateNDaysAgo(1, reportTimezone); // yesterday in Cambodia time

      Logger.info(`Generating scheduled per-follower daily report for entries on ${dateString}`);
      await this.sendFollowerReports(dateString, reportTimezone);
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
    const reportTimezone = process.env.REPORT_TIMEZONE || 'Asia/Phnom_Penh';
    const targetDate = date || getTodayDate(reportTimezone);
    Logger.info(`Generating manual per-follower daily report for entries on ${targetDate}`);
    await this.sendFollowerReports(targetDate, reportTimezone);
  }
}
