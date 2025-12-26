import { Telegraf, Context } from 'telegraf';
import { MessageHandlers } from './handlers';
import { Logger } from '../utils/logger';
import { SalesCaseRepository } from '../database/repository';
import { CustomersCommand } from './commands/customers-command';
import dotenv from 'dotenv';

dotenv.config();

export class TelegrafBotService {
  private bot: Telegraf;
  private messageHandlers: MessageHandlers;
  private repository: SalesCaseRepository;
  private customersCommand: CustomersCommand;

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN environment variable is not set');
    }

    this.bot = new Telegraf(token);
    this.messageHandlers = new MessageHandlers();
    this.repository = new SalesCaseRepository();
    this.customersCommand = new CustomersCommand(this.repository);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // /customers command
    this.bot.command('customers', async (ctx: Context) => {
      try {
        await this.customersCommand.handleCommand(ctx);
      } catch (error) {
        Logger.error('Error handling /customers command', error as Error);
        await ctx.reply('Failed to start customer list request.');
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

        // Normal message processing
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

  public getBot(): Telegraf {
    return this.bot;
  }

  public stop(): void {
    this.bot.stop();
    Logger.info('Telegraf bot stopped');
  }
}
