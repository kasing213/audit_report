import { Telegram } from 'telegraf';
import { Logger } from '../utils/logger';

export interface TelegramPdfMessage {
  update_id: number;
  message_id: number;
  file_id: string;
  file_name: string;
  caption: string;
  date: number;
}

export class PdfDownloader {
  private telegram: Telegram;
  private targetChatId: string;

  constructor(botToken: string, targetChatId: string) {
    this.telegram = new Telegram(botToken);
    this.targetChatId = targetChatId;
  }

  async getNewPdfMessages(lastUpdateId: number): Promise<TelegramPdfMessage[]> {
    const updates = await this.telegram.callApi('getUpdates', {
      offset: lastUpdateId + 1,
      limit: 100,
      timeout: 5,
    });

    const pdfMessages: TelegramPdfMessage[] = [];

    for (const update of updates as any[]) {
      const msg = update.message;
      if (!msg) continue;

      // Filter: must be from the target chat and contain a PDF document
      if (
        String(msg.chat?.id) === this.targetChatId &&
        msg.document?.mime_type === 'application/pdf'
      ) {
        pdfMessages.push({
          update_id: update.update_id,
          message_id: msg.message_id,
          file_id: msg.document.file_id,
          file_name: msg.document.file_name || 'unknown.pdf',
          caption: msg.caption || '',
          date: msg.date,
        });
        Logger.info(`Found PDF: ${msg.document.file_name} (update ${update.update_id})`);
      }
    }

    // Return the highest update_id even if no PDFs found, so we advance the offset
    if (updates.length > 0) {
      const maxUpdateId = Math.max(...(updates as any[]).map((u: any) => u.update_id));
      // Store it as a property so the caller can read it
      (pdfMessages as any)._maxUpdateId = maxUpdateId;
    }

    return pdfMessages;
  }

  getMaxUpdateId(pdfMessages: TelegramPdfMessage[], updates_maxId?: number): number {
    if (pdfMessages.length > 0) {
      return Math.max(...pdfMessages.map(m => m.update_id));
    }
    return updates_maxId || 0;
  }

  async downloadPdf(fileId: string): Promise<Buffer> {
    const fileLink = await this.telegram.getFileLink(fileId);
    const url = fileLink.toString();

    Logger.info(`Downloading PDF from: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download PDF: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async sendMessage(chatId: string, text: string, parseMode?: string): Promise<void> {
    await this.telegram.sendMessage(chatId, text, {
      parse_mode: parseMode as any,
    });
  }
}
