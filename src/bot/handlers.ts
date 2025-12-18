import { MessageParser } from '../parser/message-parser';

interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    username?: string;
    first_name?: string;
  };
  chat: {
    id: number;
    type: string;
  };
  text?: string;
  date: number;
}
import { SalesCaseRepository } from '../database/repository';
import { SalesCaseDocument } from '../database/models';
import { SalesCase } from '../parser/types';
import { Logger } from '../utils/logger';

export class MessageHandlers {
  private parser: MessageParser;
  private repository: SalesCaseRepository;

  constructor() {
    this.parser = new MessageParser();
    this.repository = new SalesCaseRepository();
  }

  public async handleMessage(message: TelegramMessage): Promise<void> {
    if (!message.text) {
      return;
    }

    const userId = message.from?.id || 0;
    const username = message.from?.username;
    const messageId = message.message_id;

    try {
      Logger.info(`Processing message from ${username || userId}: ${message.text.substring(0, 100)}...`);

      await this.repository.logAudit({
        timestamp: new Date(),
        action: 'message_received',
        message_id: messageId,
        user_id: userId,
        username,
        original_message: message.text,
        parsed_result: null
      });

      const parseResult = await this.parser.parseMessage(message.text);

      await this.repository.logAudit({
        timestamp: new Date(),
        action: 'message_parsed',
        message_id: messageId,
        user_id: userId,
        username,
        original_message: message.text,
        parsed_result: parseResult
      });

      if ('ignored' in parseResult) {
        Logger.info(`Message ignored: ${message.text}`);
        return;
      }

      const salesCaseDocs: SalesCaseDocument[] = parseResult.map((salesCase: SalesCase) => ({
        ...salesCase,
        created_at: new Date(),
        telegram_message_id: messageId,
        telegram_user_id: userId,
        telegram_username: username
      }));

      await this.repository.saveSalesCases(salesCaseDocs);

      Logger.info(`Saved ${salesCaseDocs.length} sales cases from message ${messageId}`);

      await this.repository.logAudit({
        timestamp: new Date(),
        action: 'sales_cases_saved',
        message_id: messageId,
        user_id: userId,
        username,
        original_message: message.text,
        parsed_result: { count: salesCaseDocs.length, cases: salesCaseDocs }
      });

    } catch (error) {
      Logger.error('Error processing message', error as Error);

      await this.repository.logAudit({
        timestamp: new Date(),
        action: 'processing_error',
        message_id: messageId,
        user_id: userId,
        username,
        original_message: message.text,
        parsed_result: null,
        error: (error as Error).message
      });
    }
  }
}
