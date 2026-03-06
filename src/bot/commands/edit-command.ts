import { Context, Markup } from 'telegraf';
import { SalesCaseRepository } from '../../database/repository';
import { LeadEventDocument } from '../../database/models';
import { Logger } from '../../utils/logger';
import {
  buildReasonKeyboardRows,
  buildReasonPrompt,
  parseReasonCode,
  formatReasonDisplay
} from '../../constants/reason-codes';

type EditStep = 'awaiting_phone' | 'awaiting_selection' | 'awaiting_field' | 'awaiting_value';
import {
  buildDestinationKeyboardRows,
  parseDestination
} from '../../constants/destination-options';

type EditableField = 'name' | 'phone' | 'page' | 'destination' | 'reason' | 'note' | 'date' | 'promise_date' | 'promise_status';

const FIELD_OPTIONS: { key: EditableField; label: string }[] = [
  { key: 'name', label: 'ឈ្មោះ (Name)' },
  { key: 'phone', label: 'លេខទូរស័ព្ទ (Phone)' },
  { key: 'page', label: 'ប្រភព (Page)' },
  { key: 'destination', label: 'មធ្យោបាយ (Destination)' },
  { key: 'reason', label: 'មូលហេតុ (Reason)' },
  { key: 'note', label: 'ចំណាំ (Note)' },
  { key: 'date', label: 'កាលបរិច្ឆេទ (Date)' },
  { key: 'promise_date', label: 'ថ្ងៃសន្យា (Promise Date)' },
  { key: 'promise_status', label: 'ស្ថានភាពសន្យា (Promise Status)' }
];

interface PendingEdit {
  chatId: number;
  userId: number;
  username?: string | undefined;
  step: EditStep;
  events?: LeadEventDocument[];
  selectedEvent?: LeadEventDocument;
  selectedField?: EditableField;
  expiresAt: number;
}

export class EditCommand {
  private repository: SalesCaseRepository;
  private pendingEdits: Map<number, PendingEdit> = new Map();
  private ttlMs = 5 * 60 * 1000;

  constructor(repository: SalesCaseRepository) {
    this.repository = repository;
  }

  async handleCommand(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || chatId === undefined) return;

    this.pendingEdits.set(userId, {
      chatId,
      userId,
      username: ctx.from?.username,
      step: 'awaiting_phone',
      expiresAt: Date.now() + this.ttlMs
    });

    await ctx.reply('📞 សូមបញ្ចូលលេខទូរស័ព្ទអតិថិជនដែលចង់កែ:');
  }

  isPending(userId: number): boolean {
    return this.pendingEdits.has(userId);
  }

  clearPending(userId: number): void {
    this.pendingEdits.delete(userId);
  }

  async handlePending(ctx: Context, text: string): Promise<boolean> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || chatId === undefined) return false;

    const pending = this.pendingEdits.get(userId);
    if (!pending) return false;

    if (pending.chatId !== chatId || pending.expiresAt < Date.now()) {
      this.pendingEdits.delete(userId);
      await ctx.reply('⏰ ផុតកំណត់ហើយ។ សូមវាយ /edit ម្តងទៀត។', Markup.removeKeyboard());
      return true;
    }

    try {
      if (pending.step === 'awaiting_phone') {
        return await this.handlePhoneStep(ctx, text, pending, userId);
      }

      if (pending.step === 'awaiting_selection') {
        return await this.handleSelectionStep(ctx, text, pending, userId);
      }

      if (pending.step === 'awaiting_field') {
        return await this.handleFieldStep(ctx, text, pending, userId);
      }

      if (pending.step === 'awaiting_value') {
        return await this.handleValueStep(ctx, text, pending, userId);
      }
    } catch (error) {
      Logger.error('Error in edit flow', error as Error);
      await ctx.reply('❌ មានបញ្ហា។ សូមវាយ /edit ម្តងទៀត។', Markup.removeKeyboard());
      this.pendingEdits.delete(userId);
      return true;
    }

    return false;
  }

  private async handlePhoneStep(ctx: Context, text: string, pending: PendingEdit, userId: number): Promise<boolean> {
    const phone = text.trim();
    const events = await this.repository.findEventsByPhone(phone);

    if (events.length === 0) {
      await ctx.reply('❌ រកមិនឃើញទិន្នន័យសម្រាប់លេខនេះ។\nសូមវាយ /edit ម្តងទៀត។');
      this.pendingEdits.delete(userId);
      return true;
    }

    pending.events = events;
    pending.step = 'awaiting_selection';
    pending.expiresAt = Date.now() + this.ttlMs;
    this.pendingEdits.set(userId, pending);

    const list = events.map((e, i) => {
      const reason = formatReasonDisplay(e.reason_code ?? null, e.status_text);
      return `${i + 1}) ${e.date} | ${e.customer.name || 'N/A'} | ${reason}${e.note ? ' | ' + e.note : ''}`;
    }).join('\n');

    await ctx.reply(`📋 ទិន្នន័យដែលរកឃើញ (${events.length}):\n\n${list}\n\nសូមជ្រើសរើសលេខរៀង:`);
    return true;
  }

  private async handleSelectionStep(ctx: Context, text: string, pending: PendingEdit, userId: number): Promise<boolean> {
    const index = parseInt(text.trim(), 10) - 1;
    if (isNaN(index) || !pending.events || index < 0 || index >= pending.events.length) {
      await ctx.reply(`❌ សូមបញ្ចូលលេខ 1-${pending.events?.length || 0}`);
      return true;
    }

    pending.selectedEvent = pending.events[index];
    pending.step = 'awaiting_field';
    pending.expiresAt = Date.now() + this.ttlMs;
    this.pendingEdits.set(userId, pending);

    const keyboard = Markup.keyboard(
      FIELD_OPTIONS.map(f => [f.label])
    ).resize();

    await ctx.reply('📝 សូមជ្រើសរើសវាលដែលចង់កែ:', keyboard);
    return true;
  }

  private async handleFieldStep(ctx: Context, text: string, pending: PendingEdit, userId: number): Promise<boolean> {
    const trimmed = text.trim();
    const field = FIELD_OPTIONS.find(f => f.label === trimmed || f.key === trimmed.toLowerCase());

    if (!field) {
      await ctx.reply('❌ សូមជ្រើសរើសពីបញ្ជី');
      return true;
    }

    pending.selectedField = field.key;
    pending.step = 'awaiting_value';
    pending.expiresAt = Date.now() + this.ttlMs;
    this.pendingEdits.set(userId, pending);

    if (field.key === 'reason') {
      const keyboard = Markup.keyboard(buildReasonKeyboardRows()).resize();
      await ctx.reply(buildReasonPrompt(), keyboard);
    } else if (field.key === 'destination') {
      const keyboard = Markup.keyboard(buildDestinationKeyboardRows()).resize();
      await ctx.reply('📨 សូមជ្រើសរើសមធ្យោបាយទំនាក់ទំនង:', keyboard);
    } else if (field.key === 'promise_status') {
      const keyboard = Markup.keyboard([['pending', 'came', 'didnt_come']]).resize();
      await ctx.reply('សូមជ្រើសរើសស្ថានភាព:', keyboard);
    } else {
      const currentValue = this.getCurrentValue(pending.selectedEvent!, field.key);
      await ctx.reply(
        `តម្លៃបច្ចុប្បន្ន: ${currentValue}\n\nសូមបញ្ចូលតម្លៃថ្មី:`,
        Markup.removeKeyboard()
      );
    }
    return true;
  }

  private async handleValueStep(ctx: Context, text: string, pending: PendingEdit, userId: number): Promise<boolean> {
    const event = pending.selectedEvent!;
    const field = pending.selectedField!;
    const newValue = text.trim();
    const eventId = (event as any)._id?.toString();

    if (!eventId) {
      await ctx.reply('❌ មានបញ្ហា។ សូមវាយ /edit ម្តងទៀត។', Markup.removeKeyboard());
      this.pendingEdits.delete(userId);
      return true;
    }

    const oldValue = this.getCurrentValue(event, field);
    let updates: Partial<LeadEventDocument> = {};

    switch (field) {
      case 'name':
        updates = { customer: { ...event.customer, name: newValue } };
        break;
      case 'phone':
        updates = { customer: { ...event.customer, phone: newValue } };
        break;
      case 'page':
        updates = { page: newValue };
        break;
      case 'destination':
        updates = { destination: parseDestination(newValue) || newValue };
        break;
      case 'reason': {
        const reasonCode = parseReasonCode(newValue);
        if (!reasonCode) {
          await ctx.reply('❌ សូមជ្រើសរើសតែមួយ (A–J) ប៉ុណ្ណោះ');
          return true;
        }
        updates = { reason_code: reasonCode };
        break;
      }
      case 'note':
        updates = { note: newValue === '-' ? null : newValue };
        break;
      case 'date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(newValue)) {
          await ctx.reply('❌ ទម្រង់មិនត្រឹមត្រូវ។ សូមបញ្ចូល: YYYY-MM-DD');
          return true;
        }
        updates = { date: newValue };
        break;
      case 'promise_date':
        if (newValue === '-') {
          updates = { promise_date: null, promise_status: null };
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(newValue)) {
          updates = { promise_date: newValue };
        } else {
          await ctx.reply('❌ ទម្រង់មិនត្រឹមត្រូវ។ សូមបញ្ចូល: YYYY-MM-DD ឬ "-" ដើម្បីលុប');
          return true;
        }
        break;
      case 'promise_status': {
        const validStatuses = ['pending', 'came', 'didnt_come'];
        if (!validStatuses.includes(newValue)) {
          await ctx.reply('❌ សូមជ្រើសរើស: pending, came, ឬ didnt_come');
          return true;
        }
        updates = { promise_status: newValue as 'pending' | 'came' | 'didnt_come' };
        break;
      }
    }

    const success = await this.repository.updateLeadEvent(eventId, updates);

    if (success) {
      await this.repository.logAudit({
        timestamp: new Date(),
        action: 'lead_event_edited',
        message_id: ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : 0,
        user_id: userId,
        username: pending.username,
        original_message: text,
        parsed_result: {
          event_id: eventId,
          field,
          old_value: oldValue,
          new_value: newValue
        }
      });

      await ctx.reply(
        `✅ បានកែដោយជោគជ័យ\n\n📝 ${field}: ${oldValue} → ${newValue}`,
        Markup.removeKeyboard()
      );
      Logger.info(`Lead event ${eventId} edited by user ${userId}: ${field} changed`);
    } else {
      await ctx.reply('❌ កែមិនបានសម្រេច។ សូមវាយ /edit ម្តងទៀត។', Markup.removeKeyboard());
    }

    this.pendingEdits.delete(userId);
    return true;
  }

  async startEditFromEvent(ctx: Context, eventId: string): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || chatId === undefined) return;

    const event = await this.repository.findEventById(eventId);
    if (!event) {
      await ctx.reply('❌ រកមិនឃើញទិន្នន័យនេះទេ។');
      return;
    }

    this.pendingEdits.set(userId, {
      chatId,
      userId,
      username: ctx.from?.username,
      step: 'awaiting_field',
      selectedEvent: event,
      expiresAt: Date.now() + this.ttlMs
    });

    const keyboard = Markup.keyboard(
      FIELD_OPTIONS.map(f => [f.label])
    ).resize();

    await ctx.reply('📝 សូមជ្រើសរើសវាលដែលចង់កែ:', keyboard);
  }

  private getCurrentValue(event: LeadEventDocument, field: EditableField): string {
    switch (field) {
      case 'name': return event.customer.name || 'N/A';
      case 'phone': return event.customer.phone || 'N/A';
      case 'page': return event.page || 'N/A';
      case 'destination': return event.destination || 'N/A';
      case 'reason': return formatReasonDisplay(event.reason_code ?? null, event.status_text);
      case 'note': return event.note || 'N/A';
      case 'date': return event.date;
      case 'promise_date': return event.promise_date || 'N/A';
      case 'promise_status': return event.promise_status || 'N/A';
      default: return 'N/A';
    }
  }
}
