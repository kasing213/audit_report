import puppeteer from 'puppeteer';
import * as handlebars from 'handlebars';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ReportDataService } from './data-service';
import { LeadEventDocument } from '../database/models';
import { Logger } from '../utils/logger';
import { formatReasonDisplay } from '../constants/reason-codes';
import {
  FollowerDailyPage,
  buildFollowerDailyPages,
  closeSellInfo,
  followerPageCaption,
  followerPageFilename
} from './follower-daily';

export interface FollowerDailyImage {
  follower: string;
  buffer: Buffer;
  caption: string;
  filename: string;
}

function formatTimeIn(date: Date | null | undefined, timeZone: string): string {
  if (!date) return 'N/A';
  return new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone });
}

function followerPageView(p: FollowerDailyPage, date: string, timeZone: string) {
  return {
    ...p,
    date,
    multiPage: p.pages > 1,
    showFollowUps: p.followUps.length > 0 || (p.totalFollowUps === 0 && p.page === 1),
    showClosings: p.closings.length > 0 || (p.totalClosings === 0 && p.page === p.pages),
    followUpRows: p.followUps.map((e, i) => ({
      n: p.followUpStart + i + 1,
      time: formatTimeIn(e.created_at, timeZone),
      name: e.customer?.name || '',
      phone: e.customer?.phone || '',
      page: e.page || '',
      reason: formatReasonDisplay(e.reason_code ?? null, e.status_text)
    })),
    closingRows: p.closings.map((e, i) => {
      const info = closeSellInfo(e);
      return {
        n: p.closingStart + i + 1,
        time: formatTimeIn(e.created_at, timeZone),
        // Multi-phone "012/098": allow a line break after each slash.
        phone: (e.customer?.phone || '').replace(/\//g, '/' + '\u200B'),
        page: e.page || '',
        closer: info.closer || '—',
        booked: info.booked,
        not_booked: info.not_booked,
        potential: e.source?.model === 'closesell-telegram:potential',
        reason: formatReasonDisplay(e.reason_code ?? null, e.status_text)
      };
    })
  };
}

/**
 * One JPG per follower page. Launches one browser for the whole batch and
 * always closes it. No DB access, so it can render fake data for previews.
 */
export async function renderFollowerDailyImages(
  pages: FollowerDailyPage[],
  date: string,
  timeZone = process.env.REPORT_TIMEZONE || 'Asia/Phnom_Penh'
): Promise<FollowerDailyImage[]> {
  if (pages.length === 0) return [];
  const template = handlebars.compile(
    await fs.readFile(path.join(__dirname, 'templates', 'follower-daily-report.hbs'), 'utf-8')
  );

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const out: FollowerDailyImage[] = [];
    for (const p of pages) {
      const page = await browser.newPage();
      // Narrow page + 2x scale: large, sharp text once Telegram shrinks it.
      await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 2 });
      await page.setContent(template(followerPageView(p, date, timeZone)), { waitUntil: 'networkidle0' });
      await page.evaluateHandle('document.fonts.ready');
      const buffer = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true }) as Buffer;
      await page.close();
      out.push({
        follower: p.follower,
        buffer,
        caption: followerPageCaption(p, date),
        filename: followerPageFilename(p, date)
      });
    }
    return out;
  } finally {
    await browser.close();
  }
}

export class JpgReportGenerator {
  private _dataService?: ReportDataService;
  private templatePath: string;

  constructor() {
    this.templatePath = path.join(__dirname, 'templates', 'daily-report.hbs');
  }

  // Lazy: the repository needs a live DB connection at construction time.
  private get dataService(): ReportDataService {
    return this._dataService ??= new ReportDataService();
  }

  /** Per-follower daily images for entries logged on `date` (staff sources only). */
  public async generateFollowerDailyReports(date: string, timezone?: string): Promise<FollowerDailyImage[]> {
    const tz = timezone || process.env.REPORT_TIMEZONE || 'Asia/Phnom_Penh';
    const events = await this.dataService.getLeadEventsByEntryDay(date, undefined, tz);
    const pages = buildFollowerDailyPages(events);
    Logger.info(`Daily per-follower report for ${date}: ${events.length} entries -> ${pages.length} image(s)`);
    return renderFollowerDailyImages(pages, date, tz);
  }

  private async loadTemplate(): Promise<HandlebarsTemplateDelegate> {
    try {
      const templateContent = await fs.readFile(this.templatePath, 'utf-8');
      return handlebars.compile(templateContent);
    } catch (error) {
      Logger.error('Failed to load template', error as Error);
      throw error;
    }
  }

  private setupHandlebarsHelpers(): void {
    const displayTimezone = process.env.REPORT_TIMEZONE || 'Asia/Phnom_Penh';
    handlebars.registerHelper('formatTime', (date: Date) => {
      if (!date) return 'N/A';
      return new Date(date).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: displayTimezone
      });
    });

    handlebars.registerHelper('formatReason', (reasonCode?: string | null, statusText?: string | null) => {
      return formatReasonDisplay(reasonCode ?? null, statusText ?? null);
    });
  }

  private async generateHtml(leadEvents: LeadEventDocument[], date: string, byEntryDay = false): Promise<string> {
    this.setupHandlebarsHelpers();
    const template = await this.loadTemplate();

    const templateData = {
      date,
      byEntryDay,
      totalCases: leadEvents.length,
      leadEvents,
      generatedAt: new Date().toLocaleString()
    };

    return template(templateData);
  }

  public async generateDailyReport(
    date: string,
    groupId?: string,
    opts?: { byEntryDay?: boolean; timezone?: string }
  ): Promise<Buffer> {
    try {
      const logMessage = groupId
        ? `Generating daily JPG report for ${date} (group: ${groupId}${opts?.byEntryDay ? ', by entry day' : ''})`
        : `Generating daily JPG report for ${date}${opts?.byEntryDay ? ' (by entry day)' : ''}`;
      Logger.info(logMessage);

      const leadEvents = opts?.byEntryDay
        ? await this.dataService.getLeadEventsByEntryDay(date, groupId, opts.timezone)
        : await this.dataService.getDailyLeadEvents(date, groupId);
      const html = await this.generateHtml(leadEvents, date, opts?.byEntryDay ?? false);

      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      let screenshot: Buffer;
      try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });

        // Ensure Khmer (and any other) webfonts are fully loaded before capture,
        // otherwise a slow font load can race the screenshot and render tofu boxes.
        await page.evaluateHandle('document.fonts.ready');

        await page.setViewport({
          width: 1200,
          height: 800,
          deviceScaleFactor: 1
        });

        screenshot = await page.screenshot({
          type: 'jpeg',
          quality: 90,
          fullPage: true
        }) as Buffer;
      } finally {
        await browser.close();
      }

      const successMessage = groupId
        ? `Daily JPG report generated successfully for ${date} (group: ${groupId})`
        : `Daily JPG report generated successfully for ${date}`;
      Logger.info(successMessage);
      return screenshot;

    } catch (error) {
      Logger.error('Failed to generate JPG report', error as Error);
      throw error;
    }
  }

  public async saveDailyReport(
    date: string,
    outputPath?: string,
    groupId?: string,
    opts?: { byEntryDay?: boolean; timezone?: string }
  ): Promise<string> {
    const screenshot = await this.generateDailyReport(date, groupId, opts);

    const fileName = groupId
      ? `daily-report-${date}-${groupId}.jpg`
      : `daily-report-${date}.jpg`;
    const filePath = outputPath ? path.join(outputPath, fileName) : fileName;

    await fs.writeFile(filePath, screenshot);
    Logger.info(`Daily report saved to ${filePath}`);

    return filePath;
  }
}
