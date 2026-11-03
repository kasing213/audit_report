import { Context, Markup } from 'telegraf';
import { randomBytes } from 'crypto';
import { SalesCaseRepository } from '../../database/repository';
import { LeadEventDocument } from '../../database/models';
import {
  parseCloseSellReport,
  detectCloseSellReport,
  financialLines,
  CloseSellParseResult
} from '../../parser/close-sell-parser';
import {
  StaffDirectory, StaffMember, staffDirectory, loadRoster, findStaffByName, resolveSender, enteredBy,
} from '../../staff/staff-resolver';
import { Logger } from '../../utils/logger';
import { formatReasonDisplay } from '../../constants/reason-codes';

interface PendingCloseSell {
  parsed: CloseSellParseResult;
  priorEventCount: number;
  chatId: number;
  userId: number;
  username: string | null;
  staff: CloseSellStaff | null;  // null when there is no staff roster to check against
  expiresAt: number;
}

// Names here are typed for other people by design (tour leaders, closer), so
// matching only informs the preview and the stored ids; it never blocks.
interface CloseSellStaff {
  sender: StaffMember | null;
  follower: StaffMember | null;
  closer: StaffMember | null;
}

const TTL_MS = 5 * 60 * 1000;
const PRIOR_PREVIEW_LIMIT = 3;

export class CloseSellEntryFlow {
  private repository: SalesCaseRepository;
  private pending: Map<string, PendingCloseSell>;
  private staffDir: StaffDirectory;

  constructor(repository: SalesCaseRepository, staff: StaffDirectory = staffDirectory) {
    this.repository = repository;
    this.pending = new Map();
    this.staffDir = staff;
  }

  /**
   * Static check, mirroring BulkEntryFlow.detectsBulkReport. Used by the
   * dispatcher to decide whether to route this message to Close-sell handling.
   */
  static detectsCloseSellReport(text: string): boolean {
    return detectCloseSellReport(text);
  }

  /**
   * Parse the Close-sell template strictly, stash pending state, reply with
   * preview + Confirm/Cancel buttons. Returns true if handled.
   *
   * If strict parse fails or phone is missing, returns false so the caller
   * can fall back to another path (LLM, error reply, etc.).
   */
  async tryCloseSellEntry(ctx: Context, text: string): Promise<boolean> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || chatId === undefined) return false;

    const parsed = parseCloseSellReport(text);
    if (!parsed) return false;

    const username = ctx.from?.username ?? null;
    const roster = await loadRoster(this.staffDir, this.repository);
    const staff: CloseSellStaff | null = roster && {
      sender: resolveSender(roster.staff, userId, username).member,
      follower: parsed.follower ? findStaffByName(roster.staff, roster.aliases, parsed.follower) : null,
      closer: parsed.closer ? findStaffByName(roster.staff, roster.aliases, parsed.closer) : null,
    };

    if (!parsed.phone) {
      // Surface the diagnostic and signal not-handled so other paths can try.
      const warnLine = parsed.warnings.length ? `\n⚠️ ${parsed.warnings.join('; ')}` : '';
      await ctx.reply(
        `⚠️ មិនអាចបកស្រាយ Close sell បានទេ — រកមិនឃើញលេខទូរស័ព្ទក្នុង §1.4។${warnLine}`
      );
      return true;
    }

    let priorEventCount = 0;
    let priorEvents: LeadEventDocument[] = [];
    try {
      priorEvents = await this.repository.findEventsByPhones(parsed.phones, 50);
      priorEventCount = priorEvents.length;
    } catch (err) {
      Logger.warn(`[closesell] phone lookup failed: ${(err as Error).message}`);
    }

    const token = randomBytes(4).toString('hex');
    this.pending.set(token, {
      parsed,
      priorEventCount,
      chatId,
      userId,
      username,
      staff,
      expiresAt: Date.now() + TTL_MS
    });
    this.gcExpired();
    Logger.info(`[closesell] preview created token=${token} kind=${parsed.kind} user=${userId} chat=${chatId} priorEvents=${priorEventCount}`);

    const previewText = this.buildPreview(parsed, priorEvents, staff);
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ បញ្ជាក់ / Confirm', `closesell_confirm:${token}`),
        Markup.button.callback('❌ លុប / Cancel', `closesell_cancel:${token}`)
      ]
    ]);

    await ctx.reply(previewText, {
      parse_mode: 'HTML',
      ...keyboard
    });
    return true;
  }

  async handleConfirm(ctx: Context, token: string): Promise<void> {
    const userIdForLog = ctx.from?.id ?? 'unknown';
    const pending = this.pending.get(token);
    if (!pending) {
      Logger.warn(`[closesell-confirm] token=${token} NOT in pending map`);
      await ctx.answerCbQuery('⌛ ផុតកំណត់ ឬ មិនមាន / expired');
      return;
    }
    if (Date.now() > pending.expiresAt) {
      this.pending.delete(token);
      await ctx.answerCbQuery('⌛ ផុតកំណត់ / expired');
      return;
    }
    if (ctx.from?.id !== pending.userId) {
      await ctx.answerCbQuery('តែអ្នកបង្កើតប៉ុណ្ណោះ / only the poster can confirm');
      return;
    }

    this.pending.delete(token);
    Logger.info(`[closesell-confirm] token=${token} user=${userIdForLog} kind=${pending.parsed.kind} phone=${pending.parsed.phone}`);

    try {
      const event = this.buildEvent(pending.parsed);
      Object.assign(event, {
        employee_id: pending.staff?.follower?.employee_id ?? null,
        closer_employee_id: pending.staff?.closer?.employee_id ?? null,
        entered_by: enteredBy(pending.staff?.sender, { id: pending.userId, username: pending.username }),
      });
      const eventId = await this.repository.saveLeadEvent(event);
      Logger.info(`[closesell-confirm] saveLeadEvent id=${eventId}`);

      await this.repository.saveChangeLog({
        timestamp: new Date(),
        action: 'create',
        event_id: eventId,
        event_summary: {
          customer_name: event.customer.name,
          customer_phone: event.customer.phone,
          date: event.date,
          follower: event.follower
        },
        actor: 'bot-closesell'
      });

      await this.repository.logAudit({
        timestamp: new Date(),
        action: 'closesell-telegram',
        message_id: 0,
        user_id: pending.userId,
        username: ctx.from?.username,
        original_message: pending.parsed.raw_text.slice(0, 4000),
        parsed_result: {
          event_id: eventId,
          kind: pending.parsed.kind,
          phone: pending.parsed.phone,
          prior_event_count: pending.priorEventCount,
          employee_id: event.employee_id,
          closer_employee_id: event.closer_employee_id,
          entered_by: event.entered_by
        }
      });

      await ctx.answerCbQuery('✅ បញ្ជាក់បាន / confirmed');
      const linkLine = pending.priorEventCount > 0
        ? ` (link ${pending.priorEventCount} prior event${pending.priorEventCount === 1 ? '' : 's'})`
        : '';
      await ctx.reply(`✅ បានរក្សាទុក 1 ${pending.parsed.kind === 'customer-potential' ? 'Potential' : 'Close-sell'} record${linkLine}`);
    } catch (err) {
      Logger.error(`[closesell-confirm] token=${token} FAILED`, err as Error);
      await ctx.answerCbQuery('❌ មានបញ្ហា / error');
      await ctx.reply('❌ មានបញ្ហាពេលរក្សាទុក។ សូមសាកម្តងទៀត។');
    }
  }

  async handleCancel(ctx: Context, token: string): Promise<void> {
    const pending = this.pending.get(token);
    if (!pending) {
      await ctx.answerCbQuery('⌛ ផុតកំណត់ / expired');
      return;
    }
    if (ctx.from?.id !== pending.userId) {
      await ctx.answerCbQuery('តែអ្នកបង្កើតប៉ុណ្ណោះ / only the poster can cancel');
      return;
    }
    this.pending.delete(token);
    await ctx.answerCbQuery('🚫 បានលុប / cancelled');
    await ctx.reply('🚫 បានលុបរបាយការណ៍។');
  }

  private buildPreview(parsed: CloseSellParseResult, priorEvents: LeadEventDocument[], staff: CloseSellStaff | null): string {
    const lines: string[] = [];
    const label = parsed.kind === 'customer-potential' ? 'Customer Potential' : 'Close sell';
    lines.push(`📋 <b>${label}</b>`);
    lines.push('');
    lines.push(`📅 <b>Date:</b> ${escapeHtml(parsed.date)}`);
    if (parsed.page) lines.push(`📣 <b>Page:</b> ${escapeHtml(parsed.page)}`);
    lines.push(`📞 <b>Phone:</b> <code>${escapeHtml(parsed.phone || '?')}</code>`);
    lines.push(`👤 <b>Follower (អ្នកដឹកនាំ):</b> ${escapeHtml(parsed.follower || '—')}${staffMark(parsed.follower, staff?.follower, staff)}`);
    lines.push(`🤝 <b>Closer (អ្នកបិទលក់):</b> ${escapeHtml(parsed.closer || '—')}${staffMark(parsed.closer, staff?.closer, staff)}`);
    if (parsed.tour_leaders.length > 1) {
      lines.push(`👥 <b>អ្នកដឹកនាំទាំងអស់:</b> ${escapeHtml(parsed.tour_leaders.join(', '))}`);
    }
    if (parsed.origin) lines.push(`📍 <b>From:</b> ${escapeHtml(parsed.origin)}`);
    for (const w of parsed.wants) {
      lines.push(`🏠 <b>${escapeHtml(w.label)}:</b> ${escapeHtml(w.value)}`);
    }
    if (parsed.first_contact) {
      lines.push(`🕐 <b>ទាក់ទងដំបូង:</b> ${escapeHtml(parsed.first_contact)}`);
    }

    lines.push('');
    lines.push(`✅ <b>Closed (កក់):</b> ${parsed.booked}`);
    lines.push(`⏳ <b>Not closed (មិនទាន់កក់):</b> ${parsed.not_booked}`);
    if (parsed.result_note) {
      lines.push(`🗒 <b>ផ្សេងៗ:</b> ${escapeHtml(parsed.result_note)}`);
    }
    if (parsed.primary_reason_code) {
      lines.push(`<b>Reason:</b> ${escapeHtml(formatReasonDisplay(parsed.primary_reason_code))}`);
    }
    if (parsed.obstacles.length > 0) {
      lines.push('⚠️ <b>បញ្ហាភ្ញៀវ:</b>');
      for (const ob of parsed.obstacles) lines.push(`• ${escapeHtml(ob.text)}`);
    }
    const fin = financialLines(parsed.financial);
    if (fin.length > 0) {
      lines.push('');
      lines.push('💰 <b>ស្ថានភាពហិរញ្ញវត្ថុ</b>');
      for (const [k, v] of fin) lines.push(`• ${escapeHtml(k)}: ${escapeHtml(v)}`);
    }
    lines.push(`📝 <b>បរិយាយផ្សេងៗ:</b> ${escapeHtml(parsed.description ? parsed.description.slice(0, 200) : '—')}`);

    lines.push('');
    if (priorEvents.length > 0) {
      lines.push(`🔗 <b>Linked follow-up history:</b> ${priorEvents.length} event${priorEvents.length === 1 ? '' : 's'}`);
      const recent = priorEvents.slice(0, PRIOR_PREVIEW_LIMIT);
      for (const e of recent) {
        const name = e.customer.name || '(no name)';
        const flw = e.follower || '—';
        lines.push(`• ${escapeHtml(e.date)} · ${escapeHtml(name)} · ${escapeHtml(flw)}`);
      }
      if (priorEvents.length > PRIOR_PREVIEW_LIMIT) {
        lines.push(`… +${priorEvents.length - PRIOR_PREVIEW_LIMIT} more`);
      }
    } else {
      lines.push('🆕 <b>New customer</b> (no prior follow-up events found)');
    }

    if (parsed.warnings.length > 0) {
      lines.push('');
      lines.push(`⚠️ ${escapeHtml(parsed.warnings.join('; '))}`);
    }

    lines.push('');
    lines.push('<i>Confirm within 5 minutes.</i>');
    return lines.join('\n');
  }

  private buildEvent(parsed: CloseSellParseResult): LeadEventDocument {
    const ts = Date.now();
    return {
      date: parsed.date,
      customer: {
        name: null,           // template has no explicit name field
        phone: parsed.phone   // slash-joined when multi-phone
      },
      page: parsed.page,
      destination: null,
      follower: parsed.follower,
      status_text: parsed.result_note,
      reason_code: parsed.primary_reason_code,
      note: parsed.packed_note || null,
      group_id: null,
      source: {
        telegram_msg_id: `closesell-tg-${ts}-${randomBytes(2).toString('hex')}`,
        model: parsed.kind === 'customer-potential' ? 'closesell-telegram:potential' : 'closesell-telegram'
      },
      created_at: new Date()
    };
  }

  private gcExpired(): void {
    const now = Date.now();
    for (const [token, state] of this.pending.entries()) {
      if (state.expiresAt < now) this.pending.delete(token);
    }
  }
}

/** " → Bery ✅" when a typed name is a registered employee, " ⚠️ …" when not. */
function staffMark(typed: string | null, match: StaffMember | null | undefined, staff: CloseSellStaff | null): string {
  if (!typed || !staff) return '';
  if (!match) return ' ⚠️ <i>មិនមានក្នុងបញ្ជីបុគ្គលិក</i>';
  return match.name === typed ? ' ✅' : ` → ${escapeHtml(match.name)} ✅`;
}

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
