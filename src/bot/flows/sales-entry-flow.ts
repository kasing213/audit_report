import { Context, Markup } from 'telegraf';
import { SalesCaseRepository } from '../../database/repository';
import { LeadEventDocument } from '../../database/models';
import {
  buildReasonKeyboardRows,
  buildReasonPrompt,
  parseReasonCode,
  ReasonCode
} from '../../constants/reason-codes';
import {
  buildDestinationKeyboardRows,
  parseDestination
} from '../../constants/destination-options';
import { Logger } from '../../utils/logger';
import { GroupConfigManager } from '../../utils/group-config';
import { buildInlineButtons, registerInlineTimestamp } from '../actions/inline-edit-delete';

type SalesEntryStep = 'awaiting_date' | 'awaiting_name' | 'awaiting_phone' | 'awaiting_page' | 'awaiting_destination' | 'awaiting_reason' | 'awaiting_note' | 'awaiting_promise_date';

interface PendingSalesEntry {
  chatId: number;
  userId: number;
  username?: string;
  header: { date: string; name: string; phone: string; page: string; destination: string; follower: string };
  step: SalesEntryStep;
  reasonCode?: ReasonCode;
  note?: string | null;
  promiseDate?: string | null;
  expiresAt: number;
  sourceMessageId: number;
  sourceModel?: string;
}

export class SalesEntryFlow {
  private repository: SalesCaseRepository;
  private pendingEntries: Map<number, PendingSalesEntry>;
  private ttlMs: number;
  private groupConfigManager: GroupConfigManager;

  constructor(repository: SalesCaseRepository) {
    this.repository = repository;
    this.pendingEntries = new Map();
    this.ttlMs = 5 * 60 * 1000;
    this.groupConfigManager = GroupConfigManager.getInstance();
  }

  isPending(userId: number): boolean {
    return this.pendingEntries.has(userId);
  }

  async tryArrowEntry(ctx: Context): Promise<boolean> {
    const fullText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    if (!this.parseArrowFormat(fullText)) {
      return false;
    }
    return this.startAddFlow(ctx);
  }

  async startAddFlow(ctx: Context): Promise<boolean> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || chatId === undefined) {
      return false;
    }

    if (!this.groupConfigManager.isSalesGroupChat(chatId)) {
      return false;
    }

    // Check for single-message arrow format: /add followed by → lines
    const fullText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const arrowResult = this.parseArrowFormat(fullText);

    if (arrowResult) {
      const sourceMessageId = ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : 0;

      await this.repository.logAudit({
        timestamp: new Date(),
        action: 'add_command_started',
        message_id: sourceMessageId,
        user_id: userId,
        username: ctx.from?.username,
        original_message: fullText,
        parsed_result: { mode: 'single-message' }
      });

      // Validate date
      if (!/^\d{4}-\d{2}-\d{2}$/.test(arrowResult.date)) {
        await ctx.reply('❌ ទម្រង់កាលបរិច្ឆេទមិនត្រឹមត្រូវ។ សូមបញ្ចូល: YYYY-MM-DD\nសូមវាយ /add ម្តងទៀត។');
        return true;
      }

      // Validate reason code
      const reasonCode = parseReasonCode(arrowResult.reasonCode);
      if (!reasonCode) {
        await ctx.reply('❌ លេខកូដមូលហេតុមិនត្រឹមត្រូវ។ សូមបញ្ចូល A–J\nសូមវាយ /add ម្តងទៀត។');
        return true;
      }

      // Auto-set follower from group config
      const groupId = this.groupConfigManager.getGroupIdFromChatId(chatId);
      const groupConfig = groupId ? this.groupConfigManager.getGroupConfig(groupId) : null;
      const follower = groupConfig?.name || 'Unknown';

      const destination = arrowResult.destination ? parseDestination(arrowResult.destination) : null;
      const note = this.normalizeNote(arrowResult.note);
      const promiseDate = arrowResult.promiseDate ? this.normalizePromiseDate(arrowResult.promiseDate) : null;

      const pending: PendingSalesEntry = {
        chatId,
        userId,
        ...(ctx.from?.username && { username: ctx.from.username }),
        header: {
          date: arrowResult.date,
          name: arrowResult.name,
          phone: arrowResult.phone,
          page: arrowResult.page,
          destination: destination || '',
          follower
        },
        step: 'awaiting_note',
        reasonCode,
        note,
        promiseDate,
        expiresAt: Date.now() + this.ttlMs,
        sourceMessageId,
        sourceModel: 'add-command-single'
      };

      const eventId = await this.saveEntry(pending, ctx);
      await ctx.reply('✅ ទិន្នន័យបានរក្សាទុកដោយជោគជ័យ');
      registerInlineTimestamp(eventId);
      await ctx.reply('កែ ឬ លុប:', buildInlineButtons(eventId));
      return true;
    }

    // Fall back to interactive step-by-step flow
    const pending: PendingSalesEntry = {
      chatId,
      userId,
      ...(ctx.from?.username && { username: ctx.from.username }),
      header: { date: '', name: '', phone: '', page: '', destination: '', follower: '' },
      step: 'awaiting_date',
      expiresAt: Date.now() + this.ttlMs,
      sourceMessageId: ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : 0,
      sourceModel: 'add-command'
    };

    this.pendingEntries.set(userId, pending);

    await this.repository.logAudit({
      timestamp: new Date(),
      action: 'add_command_started',
      message_id: pending.sourceMessageId,
      user_id: userId,
      username: ctx.from?.username,
      original_message: '/add',
      parsed_result: null
    });

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await ctx.reply(`📅 សូមបញ្ចូលកាលបរិច្ឆេទ (YYYY-MM-DD):\nឧទាហរណ៍: ${todayStr}`);
    return true;
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
      await ctx.reply('⏰ ផុតកំណត់ហើយ។ សូមវាយ /add ម្តងទៀត។', Markup.removeKeyboard());
      return true;
    }

    if (pending.step === 'awaiting_date') {
      const trimmed = text.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        await ctx.reply('❌ ទម្រង់មិនត្រឹមត្រូវ។ សូមបញ្ចូល: YYYY-MM-DD\nឧទាហរណ៍: 2026-02-11');
        return true;
      }
      pending.header.date = trimmed;
      pending.step = 'awaiting_name';
      pending.expiresAt = Date.now() + this.ttlMs;
      this.pendingEntries.set(userId, pending);
      await ctx.reply('👤 សូមបញ្ចូលឈ្មោះអតិថិជន:');
      return true;
    }

    if (pending.step === 'awaiting_name') {
      pending.header.name = text.trim();
      pending.step = 'awaiting_phone';
      pending.expiresAt = Date.now() + this.ttlMs;
      this.pendingEntries.set(userId, pending);
      await ctx.reply('📞 សូមបញ្ចូលលេខទូរស័ព្ទ:');
      return true;
    }

    if (pending.step === 'awaiting_phone') {
      pending.header.phone = text.trim();
      pending.step = 'awaiting_page';
      pending.expiresAt = Date.now() + this.ttlMs;
      this.pendingEntries.set(userId, pending);
      await ctx.reply('📄 សូមបញ្ចូលប្រភព (Facebook, TikTok, Sun TV, ...):');
      return true;
    }

    if (pending.step === 'awaiting_page') {
      pending.header.page = text.trim();
      pending.step = 'awaiting_destination';
      pending.expiresAt = Date.now() + this.ttlMs;
      this.pendingEntries.set(userId, pending);

      const keyboard = Markup.keyboard(buildDestinationKeyboardRows()).resize();
      await ctx.reply('📨 សូមជ្រើសរើសមធ្យោបាយទំនាក់ទំនង (Destination):', keyboard);
      return true;
    }

    if (pending.step === 'awaiting_destination') {
      pending.header.destination = parseDestination(text) || text.trim();

      // Auto-set follower from group name
      const groupId = this.groupConfigManager.getGroupIdFromChatId(chatId);
      const groupConfig = groupId ? this.groupConfigManager.getGroupConfig(groupId) : null;
      pending.header.follower = groupConfig?.name || 'Unknown';

      pending.step = 'awaiting_reason';
      pending.expiresAt = Date.now() + this.ttlMs;
      this.pendingEntries.set(userId, pending);
      await this.sendReasonPrompt(ctx);
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
      pending.expiresAt = Date.now() + this.ttlMs;
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

      pending.note = this.normalizeNote(text);
      pending.step = 'awaiting_promise_date';
      pending.expiresAt = Date.now() + this.ttlMs;
      this.pendingEntries.set(userId, pending);
      await ctx.reply('📅 តើអតិថិជនសន្យាមកថ្ងៃណា? (YYYY-MM-DD ឬវាយ "-" ដើម្បីរំលង):', Markup.removeKeyboard());
      return true;
    }

    if (pending.step === 'awaiting_promise_date') {
      const promiseDate = this.normalizePromiseDate(text);
      pending.promiseDate = promiseDate;

      const eventId = await this.saveEntry(pending, ctx);
      this.pendingEntries.delete(userId);
      await ctx.reply('✅ ទិន្នន័យបានរក្សាទុកដោយជោគជ័យ', Markup.removeKeyboard());
      registerInlineTimestamp(eventId);
      await ctx.reply('កែ ឬ លុប:', buildInlineButtons(eventId));
      return true;
    }

    return false;
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

  private normalizePromiseDate(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed || trimmed === '-' || trimmed.toLowerCase() === 'skip' || trimmed.toLowerCase() === 'none') {
      return null;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }
    return null;
  }

  private async saveEntry(pending: PendingSalesEntry, ctx: Context): Promise<string> {
    const groupId = this.groupConfigManager.getGroupIdFromChatId(pending.chatId);
    const destination = pending.header.destination || null;
    const promiseDate = pending.promiseDate || null;

    const leadEvent: LeadEventDocument = {
      date: pending.header.date,
      customer: {
        name: pending.header.name,
        phone: pending.header.phone
      },
      page: pending.header.page,
      destination,
      follower: pending.header.follower,
      status_text: null,
      reason_code: pending.reasonCode ?? null,
      note: pending.note !== undefined ? pending.note : null,
      promise_date: promiseDate,
      promise_status: promiseDate ? 'pending' : null,
      group_id: groupId,
      source: {
        telegram_msg_id: String(pending.sourceMessageId),
        model: pending.sourceModel || 'add-command'
      },
      created_at: new Date()
    };

    const eventId = await this.repository.saveLeadEvent(leadEvent);

    await this.repository.logAudit({
      timestamp: new Date(),
      action: 'lead_events_saved',
      message_id: ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : 0,
      user_id: pending.userId,
      username: pending.username,
      original_message: ctx.message && 'text' in ctx.message ? ctx.message.text : '',
      parsed_result: leadEvent
    });

    Logger.info(`Saved lead event ${eventId} for ${pending.header.phone} (group: ${groupId}, source: ${pending.sourceModel})`);
    return eventId;
  }

  private stripInvisible(text: string): string {
    // Remove zero-width and invisible Unicode characters, then trim
    return text.replace(/[\u200B\u200C\u200D\uFEFF\u00AD\u200E\u200F\u202A-\u202E\u2060-\u2064]/g, '').trim();
  }

  private parseArrowFormat(text: string): { date: string; name: string; phone: string; page: string; destination: string | null; reasonCode: string; note: string; promiseDate: string | null } | null {
    const allLines = text.split('\n').map(line => this.stripInvisible(line));

    // Find the /add line (might not be first if copied with extra text)
    const addIndex = allLines.findIndex(line => /^\/?add$/i.test(line) || line === '/add');
    if (addIndex === -1) {
      return null;
    }

    const linesAfterAdd = allLines.slice(addIndex + 1).filter(line => line.length > 0);

    // Accept various arrow characters: → ➔ ➜ ▸ ▶ > and ->
    const arrowPattern = /^(?:→|➔|➜|▸|▶|>|->)\s*/;

    // Try arrow-prefixed lines first
    let values = linesAfterAdd
      .filter(line => arrowPattern.test(line))
      .map(line => this.stripInvisible(line.replace(arrowPattern, '')));

    // Fallback: if no arrows found, use positional lines directly
    if (values.length < 6 && linesAfterAdd.length >= 6 && linesAfterAdd.length <= 8) {
      values = linesAfterAdd.map(line => this.stripInvisible(line.replace(arrowPattern, '')));
    }

    // Accept 6 lines (old format), 7 lines (with destination), or 8 lines (with destination + promise_date)
    if (values.length < 6 || values.length > 8) {
      return null;
    }

    // Normalize Unicode dashes to ASCII hyphen in date
    const date = values[0].replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\uFE58\uFE63\uFF0D]/g, '-');

    if (values.length === 6) {
      // Old format: date, name, phone, page, reasonCode, note
      return {
        date,
        name: values[1],
        phone: values[2],
        page: values[3],
        destination: null,
        reasonCode: values[4],
        note: values[5],
        promiseDate: null
      };
    }

    if (values.length === 7) {
      // 7-line format: date, name, phone, page, destination, reasonCode, note
      return {
        date,
        name: values[1],
        phone: values[2],
        page: values[3],
        destination: values[4],
        reasonCode: values[5],
        note: values[6],
        promiseDate: null
      };
    }

    // 8-line format: date, name, phone, page, destination, reasonCode, note, promiseDate
    return {
      date,
      name: values[1],
      phone: values[2],
      page: values[3],
      destination: values[4],
      reasonCode: values[5],
      note: values[6],
      promiseDate: values[7]
    };
  }

}
