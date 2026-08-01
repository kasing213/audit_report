import * as cron from 'node-cron';
import { Markup } from 'telegraf';
import { SalesCaseRepository } from '../database/repository';
import { Logger } from '../utils/logger';
import { formatReasonDisplay } from '../constants/reason-codes';

export class PromiseScheduler {
  private repository: SalesCaseRepository;
  private sendMessageCallback?: (chatId: string, text: string, extra?: any) => Promise<void>;

  constructor() {
    this.repository = new SalesCaseRepository();
  }

  public setSendMessageCallback(callback: (chatId: string, text: string, extra?: any) => Promise<void>): void {
    this.sendMessageCallback = callback;
  }

  public startScheduler(): void {
    // Schedule daily at 8:00 AM
    cron.schedule('0 8 * * *', () => {
      Logger.info('Promise reminder scheduler triggered');
      this.sendDailyReminders();
    }, {
      scheduled: true,
      timezone: process.env.TIMEZONE || 'Asia/Phnom_Penh'
    });

    Logger.info('Promise reminder scheduler started - will send reminders at 8:00 AM daily');
  }

  private async sendDailyReminders(): Promise<void> {
    try {
      const today = new Date();
      const dateString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

      const events = await this.repository.findEventsByPromiseDate(dateString);

      if (events.length === 0) {
        Logger.info(`No promise reminders for ${dateString}`);
        return;
      }

      Logger.info(`Found ${events.length} promise reminder(s) for ${dateString}`);

      const chatId = process.env.AUDIT_CHAT_ID;
      if (!chatId || !this.sendMessageCallback) {
        Logger.warn('No chat ID or callback configured for promise reminders');
        return;
      }

      for (const event of events) {
        const eventId = (event as any)._id?.toString();
        if (!eventId) continue;

        const reason = formatReasonDisplay(event.reason_code ?? null, event.status_text);
        const text = [
          '📅 *ការរំលឹកសន្យាអតិថិជន*',
          '',
          `👤 ឈ្មោះ: ${event.customer.name || 'N/A'}`,
          `📞 ទូរស័ព្ទ: ${event.customer.phone || 'N/A'}`,
          `📄 ប្រភព: ${event.page || 'N/A'}`,
          `👥 អ្នកតាមដាន: ${event.follower || 'N/A'}`,
          `🔤 មូលហេតុ: ${reason}`,
          `📅 ថ្ងៃសន្យា: ${event.promise_date}`,
        ].join('\n');

        const buttons = Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ មក (Came)', `promise_came:${eventId}`),
            Markup.button.callback('❌ មិនមក (Didn\'t Come)', `promise_didnt:${eventId}`)
          ],
          [
            Markup.button.callback('📅 ផ្លាស់ប្តូរថ្ងៃ (Reschedule)', `promise_reschedule:${eventId}`)
          ]
        ]);

        try {
          await this.sendMessageCallback(chatId, text, { parse_mode: 'Markdown', ...buttons });
          Logger.info(`Promise reminder sent for event ${eventId}`);
        } catch (err) {
          Logger.error(`Failed to send promise reminder for event ${eventId}`, err as Error);
        }
      }
    } catch (error) {
      Logger.error('Failed to send daily promise reminders', error as Error);
    }
  }
}
