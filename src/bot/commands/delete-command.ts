import { Context, Markup } from 'telegraf';
import { SalesCaseRepository } from '../../database/repository';
import { LeadEventDocument } from '../../database/models';
import { Logger } from '../../utils/logger';
import { formatReasonDisplay } from '../../constants/reason-codes';

type DeleteStep = 'awaiting_phone' | 'awaiting_selection' | 'awaiting_confirm';

interface PendingDelete {
  chatId: number;
  userId: number;
  username?: string | undefined;
  step: DeleteStep;
  events?: LeadEventDocument[];
  selectedEvent?: LeadEventDocument;
  expiresAt: number;
}

export class DeleteCommand {
  private repository: SalesCaseRepository;
  private pendingDeletes: Map<number, PendingDelete> = new Map();
  private ttlMs = 5 * 60 * 1000;

  constructor(repository: SalesCaseRepository) {
    this.repository = repository;
  }

  async handleCommand(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || chatId === undefined) return;

    this.pendingDeletes.set(userId, {
      chatId,
      userId,
      username: ctx.from?.username,
      step: 'awaiting_phone',
      expiresAt: Date.now() + this.ttlMs
    });

    await ctx.reply('📞 សូមបញ្ចូលលេខទូរស័ព្ទអតិថិជនដែលចង់លុប:');
  }

  isPending(userId: number): boolean {
    return this.pendingDeletes.has(userId);
  }

  clearPending(userId: number): void {
    this.pendingDeletes.delete(userId);
  }

  async handlePending(ctx: Context, text: string): Promise<boolean> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || chatId === undefined) return false;

    const pending = this.pendingDeletes.get(userId);
    if (!pending) return false;

    if (pending.chatId !== chatId || pending.expiresAt < Date.now()) {
      this.pendingDeletes.delete(userId);
      await ctx.reply('⏰ ផុតកំណត់ហើយ។ សូមវាយ /delete ម្តងទៀត។');
      return true;
    }

    try {
      if (pending.step === 'awaiting_phone') {
        return await this.handlePhoneStep(ctx, text, pending, userId);
      }

      if (pending.step === 'awaiting_selection') {
        return await this.handleSelectionStep(ctx, text, pending, userId);
      }

      if (pending.step === 'awaiting_confirm') {
        return await this.handleConfirmStep(ctx, text, pending, userId);
      }
    } catch (error) {
      Logger.error('Error in delete flow', error as Error);
      await ctx.reply('❌ មានបញ្ហា។ សូមវាយ /delete ម្តងទៀត។');
      this.pendingDeletes.delete(userId);
      return true;
    }

    return false;
  }

  async startDeleteFromEvent(ctx: Context, event: LeadEventDocument, _eventId?: string): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || chatId === undefined) return;

    this.pendingDeletes.set(userId, {
      chatId,
      userId,
      username: ctx.from?.username,
      step: 'awaiting_confirm',
      selectedEvent: event,
      expiresAt: Date.now() + this.ttlMs
    });

    const reason = formatReasonDisplay(event.reason_code ?? null, event.status_text);
    const detail = [
      `📅 កាលបរិច្ឆេទ: ${event.date}`,
      `👤 ឈ្មោះ: ${event.customer.name || 'N/A'}`,
      `📞 ទូរស័ព្ទ: ${event.customer.phone || 'N/A'}`,
      `📄 ប្រភព: ${event.page || 'N/A'}`,
      `🔤 មូលហេតុ: ${reason}`,
      event.note ? `📝 ចំណាំ: ${event.note}` : null
    ].filter(Boolean).join('\n');

    const keyboard = Markup.keyboard([['Yes', 'No']]).resize();
    await ctx.reply(`⚠️ តើអ្នកប្រាកដជាចង់លុបទិន្នន័យនេះ?\n\n${detail}\n\nវាយ Yes ដើម្បីលុប ឬ No ដើម្បីបោះបង់:`, keyboard);
  }

  private async handlePhoneStep(ctx: Context, text: string, pending: PendingDelete, userId: number): Promise<boolean> {
    const phone = text.trim();
    const events = await this.repository.findEventsByPhone(phone);

    if (events.length === 0) {
      await ctx.reply('❌ រកមិនឃើញទិន្នន័យសម្រាប់លេខនេះ។\nសូមវាយ /delete ម្តងទៀត។');
      this.pendingDeletes.delete(userId);
      return true;
    }

    pending.events = events;
    pending.step = 'awaiting_selection';
    pending.expiresAt = Date.now() + this.ttlMs;
    this.pendingDeletes.set(userId, pending);

    const list = events.map((e, i) => {
      const reason = formatReasonDisplay(e.reason_code ?? null, e.status_text);
      return `${i + 1}) ${e.date} | ${e.customer.name || 'N/A'} | ${reason}${e.note ? ' | ' + e.note : ''}`;
    }).join('\n');

    await ctx.reply(`📋 ទិន្នន័យដែលរកឃើញ (${events.length}):\n\n${list}\n\nសូមជ្រើសរើសលេខរៀងដែលចង់លុប:`);
    return true;
  }

  private async handleSelectionStep(ctx: Context, text: string, pending: PendingDelete, userId: number): Promise<boolean> {
    const index = parseInt(text.trim(), 10) - 1;
    if (isNaN(index) || !pending.events || index < 0 || index >= pending.events.length) {
      await ctx.reply(`❌ សូមបញ្ចូលលេខ 1-${pending.events?.length || 0}`);
      return true;
    }

    const event = pending.events[index];
    pending.selectedEvent = event;
    pending.step = 'awaiting_confirm';
    pending.expiresAt = Date.now() + this.ttlMs;
    this.pendingDeletes.set(userId, pending);

    const reason = formatReasonDisplay(event.reason_code ?? null, event.status_text);
    const detail = [
      `📅 កាលបរិច្ឆេទ: ${event.date}`,
      `👤 ឈ្មោះ: ${event.customer.name || 'N/A'}`,
      `📞 ទូរស័ព្ទ: ${event.customer.phone || 'N/A'}`,
      `📄 ប្រភព: ${event.page || 'N/A'}`,
      `🔤 មូលហេតុ: ${reason}`,
      event.note ? `📝 ចំណាំ: ${event.note}` : null
    ].filter(Boolean).join('\n');

    const keyboard = Markup.keyboard([['Yes', 'No']]).resize();
    await ctx.reply(`⚠️ តើអ្នកប្រាកដជាចង់លុបទិន្នន័យនេះ?\n\n${detail}\n\nវាយ Yes ដើម្បីលុប ឬ No ដើម្បីបោះបង់:`, keyboard);
    return true;
  }

  private async handleConfirmStep(ctx: Context, text: string, pending: PendingDelete, userId: number): Promise<boolean> {
    const answer = text.trim().toLowerCase();

    if (answer === 'no' || answer === 'n') {
      await ctx.reply('❌ បានបោះបង់ការលុប។', Markup.removeKeyboard());
      this.pendingDeletes.delete(userId);
      return true;
    }

    if (answer !== 'yes' && answer !== 'y') {
      await ctx.reply('សូមវាយ Yes ឬ No');
      return true;
    }

    const event = pending.selectedEvent!;
    const eventId = (event as any)._id?.toString();

    if (!eventId) {
      await ctx.reply('❌ មានបញ្ហា។ សូមវាយ /delete ម្តងទៀត។', Markup.removeKeyboard());
      this.pendingDeletes.delete(userId);
      return true;
    }

    const success = await this.repository.deleteLeadEvent(eventId);

    if (success) {
      await this.repository.logAudit({
        timestamp: new Date(),
        action: 'lead_event_deleted',
        message_id: ctx.message && 'message_id' in ctx.message ? ctx.message.message_id : 0,
        user_id: userId,
        username: pending.username,
        original_message: text,
        parsed_result: {
          event_id: eventId,
          deleted_event: {
            date: event.date,
            customer: event.customer,
            page: event.page,
            follower: event.follower,
            reason_code: event.reason_code
          }
        }
      });

      await ctx.reply(
        `🗑️ បានលុបដោយជោគជ័យ\n\n${event.customer.name || 'N/A'} | ${event.date}`,
        Markup.removeKeyboard()
      );
      Logger.info(`Lead event ${eventId} deleted by user ${userId}`);
    } else {
      await ctx.reply('❌ លុបមិនបានសម្រេច។ សូមវាយ /delete ម្តងទៀត។', Markup.removeKeyboard());
    }

    this.pendingDeletes.delete(userId);
    return true;
  }
}
