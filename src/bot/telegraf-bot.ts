import { Telegraf, Context } from 'telegraf';
import { Logger } from '../utils/logger';
import { SalesCaseRepository } from '../database/repository';
import { CustomersCommand } from './commands/customers-command';
import { HelpCommand } from './commands/help-command';
import { ReportCommand } from './commands/report-command';
import { SummaryCommand } from './commands/summary-command';
import { SalesEntryFlow } from './flows/sales-entry-flow';
import { GroupConfigManager } from '../utils/group-config';
import dotenv from 'dotenv';

dotenv.config();

export class TelegrafBotService {
  private bot: Telegraf;
  private repository: SalesCaseRepository;
  private customersCommand: CustomersCommand;
  private helpCommand: HelpCommand;
  private reportCommand: ReportCommand;
  private summaryCommand: SummaryCommand;
  private salesEntryFlow: SalesEntryFlow;
  private groupConfigManager: GroupConfigManager;

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN environment variable is not set');
    }

    this.bot = new Telegraf(token);
    this.repository = new SalesCaseRepository();
    this.customersCommand = new CustomersCommand(this.repository);
    this.helpCommand = new HelpCommand();
    this.reportCommand = new ReportCommand();
    this.summaryCommand = new SummaryCommand();
    this.salesEntryFlow = new SalesEntryFlow(this.repository);
    this.groupConfigManager = GroupConfigManager.getInstance();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // /help command - only in summary chat
    this.bot.command('help', async (ctx: Context) => {
      try {
        if (!this.groupConfigManager.isCommandAllowedInChat(ctx.chat?.id || 0)) {
          await ctx.reply('❌ Commands not available here\nThis chat is for data entry only (HDR format)');
          return;
        }
        await this.helpCommand.handleCommand(ctx);
      } catch (error) {
        Logger.error('Error handling /help command', error as Error);
        await ctx.reply('Failed to display help information.');
      }
    });

    // /customers command - only in summary chat
    this.bot.command('customers', async (ctx: Context) => {
      try {
        if (!this.groupConfigManager.isCommandAllowedInChat(ctx.chat?.id || 0)) {
          await ctx.reply('❌ Commands not available here\nThis chat is for data entry only (HDR format)');
          return;
        }
        await this.customersCommand.handleCommand(ctx);
      } catch (error) {
        Logger.error('Error handling /customers command', error as Error);
        await ctx.reply('Failed to start customer list request.');
      }
    });

    // /report command - only in summary chat
    this.bot.command('report', async (ctx: Context) => {
      try {
        if (!this.groupConfigManager.isCommandAllowedInChat(ctx.chat?.id || 0)) {
          await ctx.reply('❌ Commands not available here\nThis chat is for data entry only (HDR format)');
          return;
        }
        await this.reportCommand.handleCommand(ctx);
      } catch (error) {
        Logger.error('Error handling /report command', error as Error);
        await ctx.reply('Failed to process report request.');
      }
    });

    // /summary command - only in summary chat
    this.bot.command('summary', async (ctx: Context) => {
      try {
        if (!this.groupConfigManager.isCommandAllowedInChat(ctx.chat?.id || 0)) {
          await ctx.reply('❌ Commands not available here\nThis chat is for data entry only (HDR format)');
          return;
        }
        await this.summaryCommand.handleCommand(ctx);
      } catch (error) {
        Logger.error('Error handling /summary command', error as Error);
        await ctx.reply('Failed to process summary request.');
      }
    });

    // Text handler
    this.bot.on('text', async (ctx: Context) => {
      try {
        const userId = ctx.from?.id;

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

        // Sales entry flow (strict header -> reason -> note)
        if (ctx.message && 'text' in ctx.message) {
          const text = ctx.message.text;
          if (userId && this.salesEntryFlow.isPending(userId)) {
            const handled = await this.salesEntryFlow.handlePending(ctx, text);
            if (handled) return;
          }

          const started = await this.salesEntryFlow.tryStartFromHeader(ctx, text);
          if (started) return;
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
