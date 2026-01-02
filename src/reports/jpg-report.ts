import puppeteer from 'puppeteer';
import * as handlebars from 'handlebars';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ReportDataService } from './data-service';
import { LeadEventDocument } from '../database/models';
import { Logger } from '../utils/logger';
import { formatReasonDisplay } from '../constants/reason-codes';

export class JpgReportGenerator {
  private dataService: ReportDataService;
  private templatePath: string;

  constructor() {
    this.dataService = new ReportDataService();
    this.templatePath = path.join(__dirname, 'templates', 'daily-report.hbs');
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
    handlebars.registerHelper('formatTime', (date: Date) => {
      if (!date) return 'N/A';
      return new Date(date).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit'
      });
    });

    handlebars.registerHelper('formatReason', (reasonCode?: string | null, statusText?: string | null) => {
      return formatReasonDisplay(reasonCode ?? null, statusText ?? null);
    });
  }

  private async generateHtml(leadEvents: LeadEventDocument[], date: string): Promise<string> {
    this.setupHandlebarsHelpers();
    const template = await this.loadTemplate();

    const templateData = {
      date,
      totalCases: leadEvents.length,
      leadEvents,
      generatedAt: new Date().toLocaleString()
    };

    return template(templateData);
  }

  public async generateDailyReport(date: string): Promise<Buffer> {
    try {
      Logger.info(`Generating daily JPG report for ${date}`);

      const leadEvents = await this.dataService.getDailyLeadEvents(date);
      const html = await this.generateHtml(leadEvents, date);

      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });

      await page.setViewport({
        width: 1200,
        height: 800,
        deviceScaleFactor: 1
      });

      const screenshot = await page.screenshot({
        type: 'jpeg',
        quality: 90,
        fullPage: true
      });

      await browser.close();

      Logger.info(`Daily JPG report generated successfully for ${date}`);
      return screenshot as Buffer;

    } catch (error) {
      Logger.error('Failed to generate JPG report', error as Error);
      throw error;
    }
  }

  public async saveDailyReport(date: string, outputPath?: string): Promise<string> {
    const screenshot = await this.generateDailyReport(date);

    const fileName = `daily-report-${date}.jpg`;
    const filePath = outputPath ? path.join(outputPath, fileName) : fileName;

    await fs.writeFile(filePath, screenshot);
    Logger.info(`Daily report saved to ${filePath}`);

    return filePath;
  }
}
