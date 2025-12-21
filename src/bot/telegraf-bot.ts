import { Telegraf, Context } from 'telegraf';
import { MessageHandlers } from './handlers';
import { Logger } from '../utils/logger';
import { SalesCaseRepository } from '../database/repository';
import { getDateNDaysAgo, getTodayDate, toZonedDateTime } from '../utils/time';
import dotenv from 'dotenv';

dotenv.config();

export class TelegrafBotService {
  private bot: Telegraf;
  private messageHandlers: MessageHandlers;
  private repository: SalesCaseRepository;
  private reportCooldownMs: number;
  private lastReportAt: Map<number, number>;
  private pendingReportRange: Map<number, { chatId: number; expiresAt: number; type: 'report' | 'follow' }>;

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
    this.pendingReportRange = new Map();
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
        if (args.length === 0) {
          this.pendingReportRange.set(userId, { chatId: ctx.chat?.id as number, expiresAt: Date.now() + 5 * 60 * 1000, type: 'report' });
          await ctx.reply('Send a date range (YYYY-MM-DD YYYY-MM-DD) or a number of days (e.g., 7). Example: 2025-12-10 2025-12-18');
          return;
        }

        const days = this.parseDaysArg(args[0]);
        const reply = await this.buildReport(days);
        this.lastReportAt.set(userId, Date.now());
        await ctx.reply(reply);
      } catch (error) {
        Logger.error('Error handling /report command', error as Error);
        await ctx.reply('Failed to generate report.');
      }
    });

    this.bot.command('follow', async (ctx: Context) => {
      try {
        const userId = ctx.from?.id || 0;
        if (!this.canRequestReport(userId)) {
          const waitMs = this.reportCooldownMs - (Date.now() - (this.lastReportAt.get(userId) || 0));
          const waitSec = Math.ceil(waitMs / 1000);
          await ctx.reply(`Please wait ${waitSec}s before requesting another report.`);
          return;
        }

        const args = (ctx.message && 'text' in ctx.message) ? ctx.message.text.split(' ').slice(1) : [];
        if (args.length === 0) {
          this.pendingReportRange.set(userId, { chatId: ctx.chat?.id as number, expiresAt: Date.now() + 5 * 60 * 1000, type: 'follow' });
          await ctx.reply('Send a date range (YYYY-MM-DD YYYY-MM-DD) or a number of days (e.g., 7). Example: 2025-12-10 2025-12-18');
          return;
        }

        const days = this.parseDaysArg(args[0]);
        const reply = await this.buildFollowReport(days);
        this.lastReportAt.set(userId, Date.now());
        await ctx.reply(reply);
      } catch (error) {
        Logger.error('Error handling /follow command', error as Error);
        await ctx.reply('Failed to generate follow report.');
      }
    });

    this.bot.on('text', async (ctx: Context) => {
      try {
        if (await this.maybeHandlePendingRange(ctx)) {
          return;
        }

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

  private async maybeHandlePendingRange(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!userId || chatId === undefined) {
      return false;
    }

    const pending = this.pendingReportRange.get(userId);
    if (!pending) {
      return false;
    }

    if (pending.chatId !== chatId || pending.expiresAt < Date.now()) {
      this.pendingReportRange.delete(userId);
      return false;
    }

    if (!ctx.message || !('text' in ctx.message)) {
      return false;
    }

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      // Let other command handlers deal with it; clear pending to avoid confusion.
      this.pendingReportRange.delete(userId);
      return false;
    }

    const parsed = this.parseRangeOrDays(text);
    if (!parsed) {
      await ctx.reply('Invalid input. Send date range as "YYYY-MM-DD YYYY-MM-DD" or a number of days between 1 and 30.');
      return true;
    }

    try {
      let reply: string;
      if (pending.type === 'follow') {
        if (parsed.type === 'days') {
          reply = await this.buildFollowReport(parsed.days);
        } else {
          reply = await this.buildFollowReportRange(parsed.start, parsed.end, undefined, parsed.startTime, parsed.endTime);
        }
      } else {
        if (parsed.type === 'days') {
          reply = await this.buildReport(parsed.days);
        } else {
          reply = await this.buildReportRange(parsed.start, parsed.end, undefined, parsed.startTime, parsed.endTime);
        }
      }
      this.lastReportAt.set(userId, Date.now());
      await ctx.reply(reply);
    } catch (error) {
      Logger.error('Error building report from pending range', error as Error);
      await ctx.reply('Failed to generate report.');
    } finally {
      this.pendingReportRange.delete(userId);
    }

    return true;
  }

  private parseRangeOrDays(input: string): { type: 'range'; start: string; end: string; startTime?: string; endTime?: string } | { type: 'days'; days: number } | null {
    const tokens = input.trim().split(/\s+/);
    const dateTimeEntries: Array<{ date: string; time?: string }> = [];

    const dateRegex = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/;
    const pureDateRegex = /^\d{4}-\d{2}-\d{2}$/;
    const timeRegex = /^\d{2}:\d{2}$/;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (dateRegex.test(token)) {
        const [datePart, timePart] = token.includes('T') ? token.split('T') : token.split(' ');
        if (datePart && this.isValidDate(datePart)) {
          const time = timePart && timeRegex.test(timePart) ? timePart : undefined;
          const entry = time ? { date: datePart, time } : { date: datePart };
          dateTimeEntries.push(entry);
        }
        continue;
      }

      if (pureDateRegex.test(token)) {
        const datePart = token;
        let time: string | undefined;
        if (tokens[i + 1] && timeRegex.test(tokens[i + 1])) {
          time = tokens[i + 1];
          i += 1;
        }
        if (this.isValidDate(datePart)) {
          const entry = time ? { date: datePart, time } : { date: datePart };
          dateTimeEntries.push(entry);
        }
      }
    }

    if (dateTimeEntries.length >= 2) {
      const [first, second] = dateTimeEntries;
      return {
        type: 'range',
        start: first.date,
        end: second.date,
        ...(first.time ? { startTime: first.time } : {}),
        ...(second.time ? { endTime: second.time } : {})
      };
    }

    if (dateTimeEntries.length === 1) {
      const [only] = dateTimeEntries;
      return {
        type: 'range',
        start: only.date,
        end: only.date,
        ...(only.time ? { startTime: only.time, endTime: only.time } : {})
      };
    }

    const num = Number(input);
    if (Number.isFinite(num)) {
      const clamped = Math.min(Math.max(Math.trunc(num), 1), 30);
      return { type: 'days', days: clamped };
    }

    return null;
  }

  private isValidDate(dateStr: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return false;
    }
    const date = new Date(dateStr + 'T00:00:00Z');
    return !isNaN(date.getTime());
  }

  private async buildReport(days: number): Promise<string> {
    const endDate = getTodayDate();
    const startDate = getDateNDaysAgo(days - 1);
    return this.buildReportRange(startDate, endDate, days);
  }

  private async buildReportRange(startDate: string, endDate: string, daysHint?: number, startTime?: string, endTime?: string): Promise<string> {
    let normalizedStart = startDate;
    let normalizedEnd = endDate;

    if (normalizedStart > normalizedEnd) {
      [normalizedStart, normalizedEnd] = [normalizedEnd, normalizedStart];
    }

    let startDateTime = toZonedDateTime(normalizedStart, startTime || '00:00');
    let endDateTime = toZonedDateTime(normalizedEnd, endTime || '23:59');

    if (!startDateTime || !endDateTime) {
      return 'Invalid date/time format. Use YYYY-MM-DD or YYYY-MM-DD HH:MM.';
    }

    if (startDateTime > endDateTime) {
      const tmp = startDateTime;
      startDateTime = endDateTime;
      endDateTime = tmp;
    }

    const cases = await this.repository.getSalesCasesByCreatedAtRange(startDateTime, endDateTime);

    if (cases.length === 0) {
      const label = daysHint ? `${daysHint}d` : `${normalizedStart} to ${normalizedEnd}`;
      return `Report (${label}): no cases found.`;
    }

    const totalCases = cases.length;
    const uniquePhones = new Set(cases.map(c => c.phone_number).filter(Boolean)).size;
    const byPage = this.topCounts(cases.map(c => c.page).filter(Boolean));
    const byFollower = this.topCounts(cases.map(c => c.case_followed_by).filter(Boolean));
    const avgConfidence = (cases.reduce((sum, c) => sum + (c.confidence || 0), 0) / totalCases).toFixed(2);

    const pageLine = byPage.length ? byPage.map(([k, v]) => `${k}:${v}`).join(', ') : 'n/a';
    const followerLine = byFollower.length ? byFollower.map(([k, v]) => `${k}:${v}`).join(', ') : 'n/a';

    return [
      `Report (${daysHint ? `${daysHint}d` : `${normalizedStart}${startTime ? ' ' + startTime : ''} to ${normalizedEnd}${endTime ? ' ' + endTime : ''}`}):`,
      `- total cases: ${totalCases}`,
      `- unique customers (by phone): ${uniquePhones}`,
      `- avg confidence: ${avgConfidence}`,
      `- top pages: ${pageLine}`,
      `- top followed_by: ${followerLine}`
    ].join('\n');
  }

  private async buildFollowReport(days: number): Promise<string> {
    const endDate = getTodayDate();
    const startDate = getDateNDaysAgo(days - 1);
    return this.buildFollowReportRange(startDate, endDate, days);
  }

  private async buildFollowReportRange(startDate: string, endDate: string, daysHint?: number, startTime?: string, endTime?: string): Promise<string> {
    let normalizedStart = startDate;
    let normalizedEnd = endDate;

    if (normalizedStart > normalizedEnd) {
      [normalizedStart, normalizedEnd] = [normalizedEnd, normalizedStart];
    }

    let startDateTime = toZonedDateTime(normalizedStart, startTime || '00:00');
    let endDateTime = toZonedDateTime(normalizedEnd, endTime || '23:59');

    if (!startDateTime || !endDateTime) {
      return 'Invalid date/time format. Use YYYY-MM-DD or YYYY-MM-DD HH:MM.';
    }

    if (startDateTime > endDateTime) {
      const tmp = startDateTime;
      startDateTime = endDateTime;
      endDateTime = tmp;
    }

    const cases = await this.repository.getSalesCasesByCreatedAtRange(startDateTime, endDateTime);

    if (cases.length === 0) {
      const label = daysHint ? `${daysHint}d` : `${normalizedStart} to ${normalizedEnd}`;
      return `Report (${label}): no cases found.`;
    }

    const totalCases = cases.length;
    const uniquePhones = new Set(cases.map(c => c.phone_number).filter(Boolean)).size;
    const byPage = this.topCounts(cases.map(c => c.page).filter(Boolean));
    const byFollower = this.topCounts(cases.map(c => c.case_followed_by).filter(Boolean));
    const avgConfidence = (cases.reduce((sum, c) => sum + (c.confidence || 0), 0) / totalCases).toFixed(2);

    // Build detailed lists
    const phoneList = [...new Set(cases.map(c => c.phone_number).filter(Boolean))];
    const pageList = [...new Set(cases.map(c => c.page).filter(Boolean))];
    const followerList = [...new Set(cases.map(c => c.case_followed_by).filter(Boolean))];

    const phonesSection = phoneList.length > 0
      ? `\n\nPhone Numbers (${phoneList.length}):\n${phoneList.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
      : '\n\nPhone Numbers: none';

    const pagesSection = pageList.length > 0
      ? `\n\nPages (${pageList.length}):\n${pageList.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
      : '\n\nPages: none';

    const followersSection = followerList.length > 0
      ? `\n\nFollowed By (${followerList.length}):\n${followerList.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
      : '\n\nFollowed By: none';

    const header = `Report (${daysHint ? `${daysHint}d` : `${normalizedStart}${startTime ? ' ' + startTime : ''} to ${normalizedEnd}${endTime ? ' ' + endTime : ''}`}):
- total cases: ${totalCases}
- unique customers (by phone): ${uniquePhones}
- avg confidence: ${avgConfidence}
- top pages: ${byPage.map(([k, v]) => `${k}:${v}`).join(', ')}
- top followed_by: ${byFollower.map(([k, v]) => `${k}:${v}`).join(', ')}`;

    return header + phonesSection + pagesSection + followersSection;
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
