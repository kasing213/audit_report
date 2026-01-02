import { Context, Markup } from 'telegraf';
import { SalesCaseRepository } from '../../database/repository';
import { LeadEventDocument } from '../../database/models';
import { HeaderFormData, HeaderFormParser } from '../../parser/header-form-parser';
import {
  buildReasonKeyboardRows,
  buildReasonPrompt,
  parseReasonCode,
  ReasonCode
} from '../../constants/reason-codes';
import { Logger } from '../../utils/logger';

type SalesEntryStep = 'awaiting_reason' | 'awaiting_note';

interface PendingSalesEntry {
  chatId: number;
  userId: number;
  username?: string;
  header: HeaderFormData;
  step: SalesEntryStep;
  reasonCode?: ReasonCode;
  expiresAt: number;
  sourceMessageId: number;
  sourceModel?: string;
}

export class SalesEntryFlow {
  private repository: SalesCaseRepository;
  private headerParser: HeaderFormParser;
  private pendingEntries: Map<number, PendingSalesEntry>;
  private ttlMs: number;

  constructor(repository: SalesCaseRepository) {
    this.repository = repository;
    this.headerParser = new HeaderFormParser();
    this.pendingEntries = new Map();
    this.ttlMs = 5 * 60 * 1000;
  }

  isPending(userId: number): boolean {
    return this.pendingEntries.has(userId);
  }

  async handlePending(ctx: Context, text: string): Promise<boolean> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || chatId === undefined) {
      return false;
    }

    const pending = this.pendingEntries.get(userId);
    if (!pending) {
      return false;
    }

    if (pending.chatId !== chatId || pending.expiresAt < Date.now()) {
      this.pendingEntries.delete(userId);
      await ctx.reply('Entry expired. Please resend the header form.', Markup.removeKeyboard());
      return true;
    }

    if (pending.step === 'awaiting_reason') {
      const reasonCode = parseReasonCode(text);
      if (!reasonCode) {
        await ctx.reply('សូមជ្រើសរើសតែមួយ (A–J) ប៉ុណ្ណោះ');
        await this.sendReasonPrompt(ctx);
        return true;
      }

      pending.reasonCode = reasonCode;
      pending.step = 'awaiting_note';
      this.pendingEntries.set(userId, pending);

      await this.repository.logAudit({
        timestamp: new Date(),
        action: 'reason_selected',
        message_id: ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : 0,
        user_id: userId,
        username: ctx.from?.username,
        original_message: text,
        parsed_result: { reason_code: reasonCode }
      });

      await ctx.reply('បើមានចំណាំបន្ថែម សូមសរសេរជាប្រយោគខ្លីមួយ (វាយ "-" ដើម្បីរំលង):');
      return true;
    }

    if (pending.step === 'awaiting_note') {
      if (!pending.reasonCode) {
        pending.step = 'awaiting_reason';
        this.pendingEntries.set(userId, pending);
        await ctx.reply('សូមជ្រើសរើសតែមួយ (A–J) ប៉ុណ្ណោះ');
        await this.sendReasonPrompt(ctx);
        return true;
      }

      const note = this.normalizeNote(text);
      await this.saveEntry(pending, note, ctx);
      this.pendingEntries.delete(userId);
      await ctx.reply('Saved.', Markup.removeKeyboard());
      return true;
    }

    return false;
  }

  async tryStartFromHeader(ctx: Context, text: string): Promise<boolean> {
    if (text.trim().startsWith('/')) {
      return false;
    }

    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || chatId === undefined) {
      return false;
    }

    await this.repository.logAudit({
      timestamp: new Date(),
      action: 'header_received',
      message_id: ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : 0,
      user_id: userId,
      username: ctx.from?.username,
      original_message: text,
      parsed_result: null
    });

    const headerResult = await this.headerParser.parse(text);

    await this.repository.logAudit({
      timestamp: new Date(),
      action: 'header_parsed',
      message_id: ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : 0,
      user_id: userId,
      username: ctx.from?.username,
      original_message: text,
      parsed_result: headerResult
    });

    if (!headerResult.valid || !headerResult.data) {
      await ctx.reply(this.getHeaderFormatHelp(headerResult.error));
      return true;
    }

    const pending: PendingSalesEntry = {
      chatId,
      userId,
      username: ctx.from?.username,
      header: headerResult.data,
      step: 'awaiting_reason',
      expiresAt: Date.now() + this.ttlMs,
      sourceMessageId: ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : 0,
      sourceModel: headerResult.model
    };

    this.pendingEntries.set(userId, pending);
    await this.sendReasonPrompt(ctx);
    return true;
  }

  private async sendReasonPrompt(ctx: Context): Promise<void> {
    const keyboard = Markup.keyboard(buildReasonKeyboardRows()).resize();
    await ctx.reply(buildReasonPrompt(), keyboard);
  }

  private normalizeNote(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }

    const normalized = trimmed.toLowerCase();
    if (normalized === '-' || normalized === 'skip' || normalized === 'none' || normalized === 'n/a') {
      return null;
    }

    return trimmed;
  }

  private async saveEntry(pending: PendingSalesEntry, note: string | null, ctx: Context): Promise<void> {
    const leadEvent: LeadEventDocument = {
      date: pending.header.date,
      customer: {
        name: pending.header.name,
        phone: pending.header.phone
      },
      page: pending.header.page,
      follower: pending.header.follower,
      status_text: null,
      reason_code: pending.reasonCode ?? null,
      note,
      source: {
        telegram_msg_id: String(pending.sourceMessageId),
        model: pending.sourceModel || 'header-form'
      },
      created_at: new Date()
    };

    await this.repository.saveLeadEvent(leadEvent);

    await this.repository.logAudit({
      timestamp: new Date(),
      action: 'lead_events_saved',
      message_id: ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : 0,
      user_id: pending.userId,
      username: pending.username,
      original_message: ctx.message && 'text' in ctx.message ? ctx.message.text : '',
      parsed_result: leadEvent
    });

    Logger.info(`Saved lead event from header for ${pending.header.phone}`);
  }

  private getHeaderFormatHelp(error?: string): string {
    const lines = [
      'Invalid header format.',
      error ? `Reason: ${error}` : null,
      '',
      'Use this exact format:',
      'HDR',
      'DATE: YYYY-MM-DD',
      'NAME: Customer Name',
      'PHONE: Contact',
      'PAGE: Source Page',
      'FOLLOWER: Staff Name'
    ].filter(Boolean) as string[];

    return lines.join('\n');
  }
}
