import { Telegraf, Context } from 'telegraf';
import { MessageHandlers } from './handlers';
import { Logger } from '../utils/logger';
import { SalesCaseRepository } from '../database/repository';
import { getDateNDaysAgo, getTodayDate } from '../utils/time';
import dotenv from 'dotenv';

dotenv.config();

export class TelegrafBotService {
  private bot: Telegraf;
  private messageHandlers: MessageHandlers;
  private repository: SalesCaseRepository;
  private reportCooldownMs: number;
  private lastReportAt: Map<number, number>;

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN environment variable is not set');
    }

    this.bot = new Telegraf(token);
    this.messageHandlers = new MessageHandlers();
    this.repository = new SalesCaseRepository();
    this.reportCooldownMs = 5 * 60 * 1000; // 5 minutes
    this.lastReportAt = new Map();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.bot.command('report', async (ctx: Context) => {
      try {
        const userId = ctx.from?.id || 0;
        if (!this.canRequestReport(userId)) {
          const waitMs = this.reportCooldownMs - (Date.now() - (this.lastReportAt.get(userId) || 0));
          const waitSec = Math.ceil(waitMs / 1000);
          await ctx.reply(`Please wait ${waitSec}s before requesting another report.`);
          return;
        }

        const args = (ctx.message && 'text' in ctx.message) ? ctx.message.text.split(' ').slice(1) : [];
        const days = this.parseDaysArg(args[0]);
        this.lastReportAt.set(userId, Date.now());

        const reply = await this.buildReport(days);
        await ctx.reply(reply);
      } catch (error) {
        Logger.error('Error handling /report command', error as Error);
        await ctx.reply('Failed to generate report.');
      }
    });

    this.bot.on('text', async (ctx: Context) => {
      try {
        if (ctx.message && 'text' in ctx.message) {
          const telegramMessage = {
            message_id: ctx.message.message_id,
            from: ctx.message.from,
            chat: ctx.message.chat,
            text: ctx.message.text,
            date: ctx.message.date
          };

          await this.messageHandlers.handleMessage(telegramMessage);
        }
      } catch (error) {
        Logger.error('Error handling message', error as Error);
      }
    });

    this.bot.catch((err) => {
      Logger.error('Bot error', err as Error);
    });
  }

  private canRequestReport(userId: number): boolean {
    const last = this.lastReportAt.get(userId);
    if (!last) return true;
    return Date.now() - last >= this.reportCooldownMs;
  }

  private parseDaysArg(arg?: string): number {
    const parsed = arg ? Number(arg) : NaN;
    if (!Number.isFinite(parsed)) {
      return 1; // default 1 day
    }
    const clamped = Math.min(Math.max(Math.trunc(parsed), 1), 30);
    return clamped;
  }

  private async buildReport(days: number): Promise<string> {
    const endDate = getTodayDate();
    const startDate = getDateNDaysAgo(days - 1);
    const cases = await this.repository.getSalesCasesByDateRange(startDate, endDate);

    if (cases.length === 0) {
      return `Report (${days}d, ${startDate} to ${endDate}): no cases found.`;
    }

    const totalCases = cases.length;
    const uniquePhones = new Set(cases.map(c => c.phone_number).filter(Boolean)).size;
    const byPage = this.topCounts(cases.map(c => c.page).filter(Boolean));
    const byFollower = this.topCounts(cases.map(c => c.case_followed_by).filter(Boolean));
    const avgConfidence = (cases.reduce((sum, c) => sum + (c.confidence || 0), 0) / totalCases).toFixed(2);

    const pageLine = byPage.length ? byPage.map(([k, v]) => `${k}:${v}`).join(', ') : 'n/a';
    const followerLine = byFollower.length ? byFollower.map(([k, v]) => `${k}:${v}`).join(', ') : 'n/a';

    return [
      `Report (${days}d, ${startDate} to ${endDate}):`,
      `- total cases: ${totalCases}`,
      `- unique customers (by phone): ${uniquePhones}`,
      `- avg confidence: ${avgConfidence}`,
      `- top pages: ${pageLine}`,
      `- top followed_by: ${followerLine}`
    ].join('\n');
  }

  private topCounts(items: (string | null)[]): Array<[string, number]> {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (!item) continue;
      counts.set(item, (counts.get(item) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }

  public async start(): Promise<void> {
    try {
      await this.bot.launch();
      Logger.info('Telegraf bot started successfully');
    } catch (error) {
      Logger.error('Failed to start bot', error as Error);
      throw error;
    }
  }

  public async sendPhoto(chatId: string, buffer: Buffer, filename: string): Promise<void> {
    try {
      await this.bot.telegram.sendPhoto(chatId, {
        source: buffer,
        filename: filename
      }, {
        caption: `📊 ${filename.replace('.jpg', '').replace('-', ' ').toUpperCase()}\n\nGenerated: ${new Date().toLocaleString()}`
      });
      Logger.info(`Photo sent to chat ${chatId}: ${filename}`);
    } catch (error) {
      Logger.error('Failed to send photo to Telegram', error as Error);
      throw error;
    }
  }

  public getBot(): Telegraf {
    return this.bot;
  }

  public stop(): void {
    this.bot.stop();
    Logger.info('Telegraf bot stopped');
  }
}
