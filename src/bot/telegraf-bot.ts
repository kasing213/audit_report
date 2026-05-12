import { Telegraf, Context } from 'telegraf';
import { Logger } from '../utils/logger';
import { SalesCaseRepository } from '../database/repository';
import { CrmCommand } from './commands/crm-command';
import { CustomersCommand } from './commands/customers-command';
import { DeleteCommand } from './commands/delete-command';
import { EditCommand } from './commands/edit-command';
import { HelpCommand } from './commands/help-command';
import { ReportCommand } from './commands/report-command';
import { SummaryCommand } from './commands/summary-command';
import { TemperatureCommand } from './commands/temperature-command';
import { ReclassifyCommand } from './commands/reclassify-command';
import { BulkEntryFlow } from './flows/bulk-entry-flow';
import { GroupConfigManager } from '../utils/group-config';
import { isInlineExpired } from './actions/inline-edit-delete';
import dotenv from 'dotenv';

dotenv.config();

export class TelegrafBotService {
  private bot: Telegraf;
  private repository: SalesCaseRepository;
  private crmCommand: CrmCommand;
  private customersCommand: CustomersCommand;
  private deleteCommand: DeleteCommand;
  private editCommand: EditCommand;
  private helpCommand: HelpCommand;
  private reportCommand: ReportCommand;
  private summaryCommand: SummaryCommand;
  private temperatureCommand: TemperatureCommand;
  private reclassifyCommand: ReclassifyCommand;
  private bulkEntryFlow: BulkEntryFlow;
  private groupConfigManager: GroupConfigManager;
  private pendingReschedules: Map<number, { eventId: string; expiresAt: number }> = new Map();

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN environment variable is not set');
    }

    this.bot = new Telegraf(token);
    this.repository = new SalesCaseRepository();
    this.crmCommand = new CrmCommand(this.repository);
    this.customersCommand = new CustomersCommand(this.repository);
    this.deleteCommand = new DeleteCommand(this.repository);
    this.editCommand = new EditCommand(this.repository);
    this.helpCommand = new HelpCommand();
    this.reportCommand = new ReportCommand();
    this.summaryCommand = new SummaryCommand();
    this.temperatureCommand = new TemperatureCommand(this.repository);
    this.reclassifyCommand = new ReclassifyCommand(this.repository);
    this.bulkEntryFlow = new BulkEntryFlow(this.repository);
    this.groupConfigManager = GroupConfigManager.getInstance();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // /help command - available in all chats (sales guide or management help)
    this.bot.command('help', async (ctx: Context) => {
      try {
        const chatId = ctx.chat?.id || 0;
        const isSalesChat = this.groupConfigManager.isSalesGroupChat(chatId);
        await this.helpCommand.handleCommand(ctx, isSalesChat);
      } catch (error) {
        Logger.error('Error handling /help command', error as Error);
        await ctx.reply('Failed to display help information.');
      }
    });

    // /customers command - only in summary/audit chat
    this.bot.command('customers', async (ctx: Context) => {
      try {
        if (!this.groupConfigManager.isCommandAllowedInChat(ctx.chat?.id || 0)) {
          await ctx.reply('❌ ពាក្យបញ្ជានេះមិនអាចប្រើនៅទីនេះបានទេ\nសូមបិទភ្ជាប់ទំរង់ Bulk ដើម្បីបញ្ចូលទិន្នន័យ');
          return;
        }
        await this.customersCommand.handleCommand(ctx);
      } catch (error) {
        Logger.error('Error handling /customers command', error as Error);
        await ctx.reply('Failed to start customer list request.');
      }
    });

    // /crm command - only in summary/audit chat
    this.bot.command('crm', async (ctx: Context) => {
      try {
        if (!this.groupConfigManager.isCommandAllowedInChat(ctx.chat?.id || 0)) {
          await ctx.reply('❌ ពាក្យបញ្ជានេះមិនអាចប្រើនៅទីនេះបានទេ\nសូមបិទភ្ជាប់ទំរង់ Bulk ដើម្បីបញ្ចូលទិន្នន័យ');
          return;
        }
        await this.crmCommand.handleCommand(ctx);
      } catch (error) {
        Logger.error('Error handling /crm command', error as Error);
        await ctx.reply('❌ Failed to start CRM lookup.');
      }
    });

    // /report command - only in summary/audit chat
    this.bot.command('report', async (ctx: Context) => {
      try {
        if (!this.groupConfigManager.isCommandAllowedInChat(ctx.chat?.id || 0)) {
          await ctx.reply('❌ ពាក្យបញ្ជានេះមិនអាចប្រើនៅទីនេះបានទេ\nសូមបិទភ្ជាប់ទំរង់ Bulk ដើម្បីបញ្ចូលទិន្នន័យ');
          return;
        }
        await this.reportCommand.handleCommand(ctx);
      } catch (error) {
        Logger.error('Error handling /report command', error as Error);
        await ctx.reply('Failed to process report request.');
      }
    });

    // /summary command - only in summary/audit chat
    this.bot.command('summary', async (ctx: Context) => {
      try {
        if (!this.groupConfigManager.isCommandAllowedInChat(ctx.chat?.id || 0)) {
          await ctx.reply('❌ ពាក្យបញ្ជានេះមិនអាចប្រើនៅទីនេះបានទេ\nសូមបិទភ្ជាប់ទំរង់ Bulk ដើម្បីបញ្ចូលទិន្នន័យ');
          return;
        }
        await this.summaryCommand.handleCommand(ctx);
      } catch (error) {
        Logger.error('Error handling /summary command', error as Error);
        await ctx.reply('Failed to process summary request.');
      }
    });

    // /hot, /warm, /cold — list customers by temperature (current month)
    this.bot.command('hot', async (ctx: Context) => {
      try {
        if (!this.groupConfigManager.isCommandAllowedInChat(ctx.chat?.id || 0)) {
          await ctx.reply('❌ ពាក្យបញ្ជានេះមិនអាចប្រើនៅទីនេះបានទេ');
          return;
        }
        await this.temperatureCommand.handleCommand(ctx, 'hot');
      } catch (error) {
        Logger.error('Error handling /hot command', error as Error);
        await ctx.reply('❌ Failed to fetch hot leads.');
      }
    });

    this.bot.command('warm', async (ctx: Context) => {
      try {
        if (!this.groupConfigManager.isCommandAllowedInChat(ctx.chat?.id || 0)) {
          await ctx.reply('❌ ពាក្យបញ្ជានេះមិនអាចប្រើនៅទីនេះបានទេ');
          return;
        }
        await this.temperatureCommand.handleCommand(ctx, 'warm');
      } catch (error) {
        Logger.error('Error handling /warm command', error as Error);
        await ctx.reply('❌ Failed to fetch warm leads.');
      }
    });

    this.bot.command('cold', async (ctx: Context) => {
      try {
        if (!this.groupConfigManager.isCommandAllowedInChat(ctx.chat?.id || 0)) {
          await ctx.reply('❌ ពាក្យបញ្ជានេះមិនអាចប្រើនៅទីនេះបានទេ');
          return;
        }
        await this.temperatureCommand.handleCommand(ctx, 'cold');
      } catch (error) {
        Logger.error('Error handling /cold command', error as Error);
        await ctx.reply('❌ Failed to fetch cold leads.');
      }
    });

    // /reclassify <phone> [hot|warm|cold]
    this.bot.command('reclassify', async (ctx: Context) => {
      try {
        if (!this.groupConfigManager.isCommandAllowedInChat(ctx.chat?.id || 0)) {
          await ctx.reply('❌ ពាក្យបញ្ជានេះមិនអាចប្រើនៅទីនេះបានទេ');
          return;
        }
        await this.reclassifyCommand.handleCommand(ctx);
      } catch (error) {
        Logger.error('Error handling /reclassify command', error as Error);
        await ctx.reply('❌ Failed to reclassify.');
      }
    });

    // /edit command - available in all chats
    this.bot.command('edit', async (ctx: Context) => {
      try {
        await this.editCommand.handleCommand(ctx);
      } catch (error) {
        Logger.error('Error handling /edit command', error as Error);
        await ctx.reply('❌ Failed to start edit flow.');
      }
    });

    // /delete command - available in all chats
    this.bot.command('delete', async (ctx: Context) => {
      try {
        await this.deleteCommand.handleCommand(ctx);
      } catch (error) {
        Logger.error('Error handling /delete command', error as Error);
        await ctx.reply('❌ Failed to start delete flow.');
      }
    });

    // /add command was removed: bulk paste is the only data-entry path. Reply
    // with a pointer so old muscle-memory still gets routed to the new flow.
    this.bot.command('add', async (ctx: Context) => {
      try {
        await ctx.reply('ℹ️ /add ត្រូវបានដកចេញ — សូមប្រើ /help យក​ទំរង់ Bulk រួចបិទភ្ជាប់ក្នុងក្រុមនេះ');
      } catch (error) {
        Logger.error('Error handling /add command', error as Error);
      }
    });

    // Inline button: Edit from save
    this.bot.action(/^edit:(.+)$/, async (ctx) => {
      try {
        const eventId = (ctx as any).match[1];
        if (isInlineExpired(eventId)) {
          await ctx.answerCbQuery('⏰ ផុតកំណត់ហើយ។ សូមប្រើ /edit');
          return;
        }
        await ctx.answerCbQuery();
        await this.editCommand.startEditFromEvent(ctx, eventId);
      } catch (error) {
        Logger.error('Error handling inline edit', error as Error);
        await ctx.answerCbQuery('❌ មានបញ្ហា');
      }
    });

    // Inline button: Delete from save
    this.bot.action(/^delete:(.+)$/, async (ctx) => {
      try {
        const eventId = (ctx as any).match[1];
        if (isInlineExpired(eventId)) {
          await ctx.answerCbQuery('⏰ ផុតកំណត់ហើយ។ សូមប្រើ /delete');
          return;
        }
        await ctx.answerCbQuery();
        const event = await this.repository.findEventById(eventId);
        if (!event) {
          await ctx.reply('❌ រកមិនឃើញទិន្នន័យនេះទេ។');
          return;
        }
        await this.deleteCommand.startDeleteFromEvent(ctx, event, eventId);
      } catch (error) {
        Logger.error('Error handling inline delete', error as Error);
        await ctx.answerCbQuery('❌ មានបញ្ហា');
      }
    });

    // Promise callback: Came
    this.bot.action(/^promise_came:(.+)$/, async (ctx) => {
      try {
        const eventId = (ctx as any).match[1];
        const success = await this.repository.updatePromiseStatus(eventId, 'came');
        if (success) {
          await ctx.editMessageText('✅ អតិថិជនបានមក (Came)');
        }
        await ctx.answerCbQuery(success ? '✅ បានកត់ត្រា' : '❌ មានបញ្ហា');
      } catch (error) {
        Logger.error('Error handling promise_came', error as Error);
        await ctx.answerCbQuery('❌ មានបញ្ហា');
      }
    });

    // Promise callback: Didn't come
    this.bot.action(/^promise_didnt:(.+)$/, async (ctx) => {
      try {
        const eventId = (ctx as any).match[1];
        const success = await this.repository.updatePromiseStatus(eventId, 'didnt_come');
        if (success) {
          await ctx.editMessageText('❌ អតិថិជនមិនបានមក (Didn\'t Come)');
        }
        await ctx.answerCbQuery(success ? '✅ បានកត់ត្រា' : '❌ មានបញ្ហា');
      } catch (error) {
        Logger.error('Error handling promise_didnt', error as Error);
        await ctx.answerCbQuery('❌ មានបញ្ហា');
      }
    });

    // Promise callback: Reschedule
    this.bot.action(/^promise_reschedule:(.+)$/, async (ctx) => {
      try {
        const eventId = (ctx as any).match[1];
        const userId = ctx.from?.id;
        if (!userId) {
          await ctx.answerCbQuery('❌ មានបញ្ហា');
          return;
        }
        this.pendingReschedules.set(userId, { eventId, expiresAt: Date.now() + 5 * 60 * 1000 });
        await ctx.answerCbQuery();
        await ctx.reply('📅 សូមបញ្ចូលថ្ងៃថ្មី (YYYY-MM-DD):');
      } catch (error) {
        Logger.error('Error handling promise_reschedule', error as Error);
        await ctx.answerCbQuery('❌ មានបញ្ហា');
      }
    });

    // Bulk-report callbacks
    this.bot.action(/^bulk_confirm:(.+)$/, async (ctx) => {
      const token = (ctx as any).match?.[1];
      Logger.info(`[bulk-confirm] action fired token=${token} user=${ctx.from?.id} chat=${ctx.chat?.id}`);
      try {
        await this.bulkEntryFlow.handleConfirm(ctx, token);
      } catch (error) {
        Logger.error('Error handling bulk_confirm', error as Error);
        await ctx.answerCbQuery('❌ មានបញ្ហា');
      }
    });
    this.bot.action(/^bulk_cancel:(.+)$/, async (ctx) => {
      const token = (ctx as any).match?.[1];
      Logger.info(`[bulk-confirm] cancel fired token=${token} user=${ctx.from?.id} chat=${ctx.chat?.id}`);
      try {
        await this.bulkEntryFlow.handleCancel(ctx, token);
      } catch (error) {
        Logger.error('Error handling bulk_cancel', error as Error);
        await ctx.answerCbQuery('❌ មានបញ្ហា');
      }
    });

    // Text handler
    this.bot.on('text', async (ctx: Context) => {
      try {
        const userId = ctx.from?.id;

        // Check for pending promise reschedule
        if (userId && this.pendingReschedules.has(userId)) {
          const reschedule = this.pendingReschedules.get(userId)!;
          if (reschedule.expiresAt < Date.now()) {
            this.pendingReschedules.delete(userId);
          } else {
            const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : '';
            if (!text.startsWith('/')) {
              const trimmed = text.trim();
              if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
                const success = await this.repository.reschedulePromise(reschedule.eventId, trimmed);
                this.pendingReschedules.delete(userId);
                await ctx.reply(success ? `📅 បានផ្លាស់ប្តូរថ្ងៃទៅ ${trimmed}` : '❌ មានបញ្ហា');
                return;
              } else {
                await ctx.reply('❌ ទម្រង់មិនត្រឹមត្រូវ។ សូមបញ្ចូល: YYYY-MM-DD');
                return;
              }
            } else {
              this.pendingReschedules.delete(userId);
            }
          }
        }

        // Check for pending CRM request
        if (userId && this.crmCommand.isPending(userId)) {
          const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : '';
          if (!text.startsWith('/')) {
            const handled = await this.crmCommand.handlePending(ctx, text);
            if (handled) return;
          } else {
            this.crmCommand.clearPending(userId);
          }
        }

        // Check for pending customers request
        if (userId && this.customersCommand.isPendingRequest(userId)) {
          const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : '';
          if (!text.startsWith('/')) {
            const handled = await this.customersCommand.handlePendingRequest(ctx, text);
            if (handled) return;
          } else {
            this.customersCommand.clearPendingRequest(userId);
          }
        }

        // Check for pending edit request
        if (userId && this.editCommand.isPending(userId)) {
          const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : '';
          if (!text.startsWith('/')) {
            const handled = await this.editCommand.handlePending(ctx, text);
            if (handled) return;
          } else {
            this.editCommand.clearPending(userId);
          }
        }

        // Check for pending delete request
        if (userId && this.deleteCommand.isPending(userId)) {
          const text = (ctx.message && 'text' in ctx.message) ? ctx.message.text : '';
          if (!text.startsWith('/')) {
            const handled = await this.deleteCommand.handlePending(ctx, text);
            if (handled) return;
          } else {
            this.deleteCommand.clearPending(userId);
          }
        }

        // Bulk daily-report paste — detect via header + Tel lines.
        if (ctx.message && 'text' in ctx.message) {
          const text = ctx.message.text;
          if (BulkEntryFlow.detectsBulkReport(text)) {
            const chatId = ctx.chat?.id || 0;
            if (
              this.groupConfigManager.isSalesGroupChat(chatId) ||
              this.groupConfigManager.isCommandAllowedInChat(chatId)
            ) {
              const handled = await this.bulkEntryFlow.tryBulkEntry(ctx, text);
              if (handled) return;
            }
          }
        }
      } catch (error) {
        Logger.error('Error handling message', error as Error);
      }
    });

    // Error handler
    this.bot.catch((err) => {
      Logger.error('Bot error', err as Error);
    });
  }

  public async start(): Promise<void> {
    // Telegraf's bot.launch() resolves only when the bot stops. Awaiting it
    // would block main() and prevent every cron scheduler (daily reports,
    // promise reminders, outreach scan) from ever being registered. Fire it
    // off in the background and surface launch errors via the catch handler.
    this.bot.launch().catch((error) => {
      Logger.error('Bot polling crashed', error as Error);
    });
    Logger.info('Telegraf bot started successfully');
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

  public async sendMessage(chatId: string, text: string, extra?: any): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(chatId, text, extra);
      Logger.info(`Message sent to chat ${chatId}`);
    } catch (error) {
      Logger.error('Failed to send message to Telegram', error as Error);
      throw error;
    }
  }

  public async sendDocument(chatId: string, buffer: Buffer, filename: string, caption?: string): Promise<void> {
    try {
      const options = caption ? {
        caption: caption,
        parse_mode: 'Markdown' as const
      } : {};

      await this.bot.telegram.sendDocument(chatId, {
        source: buffer,
        filename: filename
      }, options);
      Logger.info(`Document sent to chat ${chatId}: ${filename}`);
    } catch (error) {
      Logger.error('Failed to send document to Telegram', error as Error);
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
