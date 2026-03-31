import * as cron from 'node-cron';
import { PdfDownloader } from './pdf-downloader';
import { parseAdReportPdf } from './pdf-parser';
import { AdReportRepository } from './ad-report-repository';
import { AdCorrelationService } from './ad-correlation-service';
import { formatDailySummary } from './ad-summary-formatter';
import { AdReportDocument } from './ad-report-models';
import { Logger } from '../utils/logger';

export class AdScannerScheduler {
  private downloader: PdfDownloader;
  private repository: AdReportRepository;
  private correlationService: AdCorrelationService;
  private targetChatId: string;
  private summaryChatId: string;

  constructor() {
    const botToken = process.env.INTERNAL_BOT_TOKEN;
    if (!botToken) {
      throw new Error('INTERNAL_BOT_TOKEN not set');
    }

    this.targetChatId = process.env.AD_REPORT_CHAT_ID || '';
    this.summaryChatId = process.env.AUDIT_CHAT_ID || process.env.AD_REPORT_CHAT_ID || '';

    this.downloader = new PdfDownloader(botToken, this.targetChatId);
    this.repository = new AdReportRepository();
    this.correlationService = new AdCorrelationService(this.repository);
  }

  startScheduler(): void {
    // Run at 9:30 AM daily (after PDF arrives ~8:20 AM)
    cron.schedule('30 9 * * *', () => {
      Logger.info('Ad scanner scheduled task triggered');
      this.scanAndProcess();
    }, {
      scheduled: true,
      timezone: process.env.TIMEZONE || 'Asia/Kuala_Lumpur',
    });

    Logger.info('Ad scanner scheduler started - will scan at 9:30 AM daily');
    Logger.info(`Target chat ID: ${this.targetChatId}`);
    Logger.info(`Summary chat ID: ${this.summaryChatId}`);
  }

  async scanAndProcess(): Promise<void> {
    try {
      Logger.info('Starting ad report scan...');

      // Get last processed update ID
      const lastUpdateId = await this.repository.getLastUpdateId();
      Logger.info(`Last processed update ID: ${lastUpdateId}`);

      // Poll for new PDF messages
      const pdfMessages = await this.downloader.getNewPdfMessages(lastUpdateId);

      if (pdfMessages.length === 0) {
        Logger.info('No new PDF reports found');
        // Still advance the offset if there were any updates
        const maxId = (pdfMessages as any)._maxUpdateId;
        if (maxId && maxId > lastUpdateId) {
          await this.repository.setLastUpdateId(maxId);
        }
        return;
      }

      Logger.info(`Found ${pdfMessages.length} new PDF report(s)`);

      for (const pdfMsg of pdfMessages) {
        try {
          // Download PDF
          const pdfBuffer = await this.downloader.downloadPdf(pdfMsg.file_id);
          Logger.info(`Downloaded PDF: ${pdfMsg.file_name} (${pdfBuffer.length} bytes)`);

          // Parse PDF
          const parsed = await parseAdReportPdf(pdfBuffer);
          Logger.info(`Parsed report for date: ${parsed.date}`);

          // Check for duplicate
          const existing = await this.repository.findByDate(parsed.date);
          if (existing) {
            Logger.info(`Report for ${parsed.date} already exists, skipping`);
            continue;
          }

          // Save to MongoDB
          const doc: AdReportDocument = {
            ...parsed,
            source: {
              telegram_msg_id: pdfMsg.message_id,
              file_id: pdfMsg.file_id,
              caption: pdfMsg.caption,
            },
            created_at: new Date(),
          };

          await this.repository.save(doc);
          Logger.info(`Saved ad report for ${parsed.date}`);

          // Calculate correlation with sales
          const correlation = await this.correlationService.getDailyCorrelation(parsed.date);

          // Format and send summary
          const summary = formatDailySummary(doc, correlation);

          if (this.summaryChatId) {
            await this.downloader.sendMessage(this.summaryChatId, summary);
            Logger.info(`Summary sent to chat ${this.summaryChatId}`);
          }

        } catch (err) {
          Logger.error(`Failed to process PDF ${pdfMsg.file_name}`, err as Error);
        }
      }

      // Update offset to the highest update_id we processed
      const maxProcessedId = Math.max(...pdfMessages.map(m => m.update_id));
      const maxOverallId = (pdfMessages as any)._maxUpdateId || maxProcessedId;
      const newOffset = Math.max(maxProcessedId, maxOverallId);
      await this.repository.setLastUpdateId(newOffset);
      Logger.info(`Updated last update ID to ${newOffset}`);

    } catch (error) {
      Logger.error('Ad scanner failed', error as Error);
    }
  }

  // Manual trigger for testing or missed scans
  async manualScan(): Promise<void> {
    Logger.info('Manual ad scan triggered');
    await this.scanAndProcess();
  }
}
