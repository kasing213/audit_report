import { Context, Markup } from 'telegraf';
import { randomBytes } from 'crypto';
import { SalesCaseRepository } from '../../database/repository';
import { LeadEventDocument, DailySummaryDocument } from '../../database/models';
import { parseBulkReport, BulkReportParseResult } from '../../parser/bulk-report-parser';
import { GroupConfigManager } from '../../utils/group-config';
import { Logger } from '../../utils/logger';
import { formatReasonDisplay } from '../../constants/reason-codes';

interface PendingBulk {
  parsed: BulkReportParseResult;
  chatId: number;
  userId: number;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const PREVIEW_DRAFT_LIMIT = 10;

export class BulkEntryFlow {
  private repository: SalesCaseRepository;
  private pending: Map<string, PendingBulk>; // token → state
  private groupConfig: GroupConfigManager;

  constructor(repository: SalesCaseRepository) {
    this.repository = repository;
    this.pending = new Map();
    this.groupConfig = GroupConfigManager.getInstance();
  }

  static detectsBulkReport(text: string): boolean {
    if (!text || text.length < 40) return false;
    // Header marker (Khmer "report" word or "date" word with a date) + at least one Tel slot line.
    const hasHeader = /របាយការណ៍|ថ្ងៃទី\s*\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{2,4}/.test(text);
    if (!hasHeader) return false;
    const hasTel = /(^|\n)\s*T\s*el?\s*\d{1,2}\s*=/i.test(text);
    return hasTel;
  }

  /**
   * Parse the pasted report, stash pending state, reply with preview + inline buttons.
   * Returns true if handled (caller should not fall through to other handlers).
   */
  async tryBulkEntry(ctx: Context, text: string): Promise<boolean> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || chatId === undefined) return false;

    const parsed = parseBulkReport(text);

    // Auto-fill follower from group config when posting in a sales group.
    if (!parsed.header.follower && this.groupConfig.isSalesGroupChat(chatId)) {
      const groupId = this.groupConfig.getGroupIdFromChatId(chatId);
      const cfg = groupId ? this.groupConfig.getGroupConfig(groupId) : null;
      if (cfg?.name) {
        parsed.header.follower = cfg.name;
      }
    }

    if (parsed.drafts.length === 0 && Object.keys(parsed.summary.counters).length === 0) {
      await ctx.reply(
        '⚠️ ការបកស្រាយមិនបានរកឃើញ Tel ឬ counter ណាមួយឡើយ។ សូមពិនិត្យមើលទម្រង់របាយការណ៍។',
      );
      return true;
    }

    const token = randomBytes(4).toString('hex');
    this.pending.set(token, {
      parsed,
      chatId,
      userId,
      expiresAt: Date.now() + TTL_MS,
    });
    this.gcExpired();

    const previewText = this.buildPreview(parsed);
    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ បញ្ជាក់ / Confirm', `bulk_confirm:${token}`),
        Markup.button.callback('❌ លុប / Cancel', `bulk_cancel:${token}`),
      ],
    ]);

    await ctx.reply(previewText, {
      parse_mode: 'HTML',
      ...keyboard,
    });

    return true;
  }

  async handleConfirm(ctx: Context, token: string): Promise<void> {
    const pending = this.pending.get(token);
    if (!pending) {
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

    try {
      const { events, skipped } = this.buildEvents(pending.parsed);
      const eventIds = events.length ? await this.repository.saveLeadEvents(events) : [];

      let summaryId: string | null = null;
      if (Object.keys(pending.parsed.summary.counters).length > 0) {
        const summaryDoc: DailySummaryDocument = {
          date: pending.parsed.header.date,
          follower: pending.parsed.header.follower,
          page: pending.parsed.header.page,
          counters: pending.parsed.summary.counters,
          raw_text: pending.parsed.summary.raw_text.slice(0, 20_000),
          source: { model: 'bulk-telegram' },
          created_at: new Date(),
        };
        summaryId = await this.repository.saveDailySummary(summaryDoc);
      }

      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const evId = eventIds[i];
        if (!evId) continue;
        await this.repository.saveChangeLog({
          timestamp: new Date(),
          action: 'create',
          event_id: evId,
          event_summary: {
            customer_name: ev.customer.name,
            customer_phone: ev.customer.phone,
            date: ev.date,
            follower: ev.follower,
          },
          actor: 'bot-bulk',
        });
      }

      await this.repository.logAudit({
        timestamp: new Date(),
        action: 'bulk-telegram',
        message_id: 0,
        user_id: pending.userId,
        username: ctx.from?.username,
        original_message: `Bulk from telegram: ${events.length} events, summary=${summaryId ? 'yes' : 'no'}`,
        parsed_result: {
          event_ids: eventIds,
          summary_id: summaryId,
          imported: events.length,
          skipped,
          header: pending.parsed.header,
        },
      });

      const summaryLine = summaryId ? ' + daily summary' : '';
      await ctx.answerCbQuery(`✅ បញ្ជាក់បាន / confirmed`);
      await ctx.reply(
        `✅ បានរក្សាទុក ${events.length} លេខ${summaryLine}` +
          (skipped ? ` (រំលង ${skipped})` : ''),
      );
    } catch (err) {
      Logger.error('bulk confirm failed', err as Error);
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

  private buildPreview(parsed: BulkReportParseResult): string {
    const { header, drafts, summary, empty_slots, warnings } = parsed;
    const lines: string[] = [];
    lines.push('📋 <b>Bulk Daily Report</b>');
    lines.push('');
    lines.push(`📅 <b>Date:</b> ${escapeHtml(header.date)}`);
    lines.push(`👤 <b>Follower:</b> ${escapeHtml(header.follower || '—')}`);
    if (header.page) lines.push(`📣 <b>Page:</b> ${escapeHtml(header.page)}`);
    lines.push('');
    lines.push(`<b>Leads: ${drafts.length}</b> (empty slots: ${empty_slots})`);

    if (drafts.length > 0) {
      lines.push('');
      const shown = drafts.slice(0, PREVIEW_DRAFT_LIMIT);
      for (const d of shown) {
        const reason = d.reason_code ? formatReasonDisplay(d.reason_code) : '—';
        const name = d.customer_name || '(no name)';
        const promise = d.promise_date ? ` · 📅 ${d.promise_date}` : '';
        lines.push(
          `• <code>${escapeHtml(d.slot)}</code> ${escapeHtml(d.customer_phone || '?')} · ${escapeHtml(name)} · ${escapeHtml(reason)}${promise}`,
        );
      }
      if (drafts.length > PREVIEW_DRAFT_LIMIT) {
        lines.push(`… + ${drafts.length - PREVIEW_DRAFT_LIMIT} more`);
      }
    }

    const counterKeys = Object.keys(summary.counters);
    if (counterKeys.length > 0) {
      lines.push('');
      lines.push(`<b>Counters (${counterKeys.length}):</b>`);
      const pieces = counterKeys.slice(0, 12).map(k => `${escapeHtml(k)}=${summary.counters[k]}`);
      lines.push(pieces.join(' · '));
      if (counterKeys.length > 12) lines.push(`… +${counterKeys.length - 12} more`);
    }

    if (warnings.length > 0) {
      lines.push('');
      lines.push(`⚠️ ${escapeHtml(warnings.join('; '))}`);
    }

    lines.push('');
    lines.push('<i>Confirm within 5 minutes.</i>');
    return lines.join('\n');
  }

  private buildEvents(parsed: BulkReportParseResult): { events: LeadEventDocument[]; skipped: number } {
    const events: LeadEventDocument[] = [];
    const ts = Date.now();
    let skipped = 0;
    for (const d of parsed.drafts) {
      if (!d.customer_phone) { skipped++; continue; }
      const slot = String(d.slot || `slot-${events.length + 1}`).slice(0, 40);
      events.push({
        date: d.date || parsed.header.date,
        customer: {
          name: d.customer_name || null,
          phone: d.customer_phone,
        },
        page: d.page || parsed.header.page || null,
        destination: null,
        follower: d.follower || parsed.header.follower || null,
        status_text: null,
        reason_code: d.reason_code || null,
        note: d.note || null,
        promise_date: d.promise_date || null,
        promise_status: d.promise_date ? 'pending' : null,
        group_id: null,
        source: {
          telegram_msg_id: `bulk-tg-${ts}-${slot}`,
          model: 'bulk-telegram',
        },
        created_at: new Date(),
      });
    }
    return { events, skipped };
  }

  private gcExpired(): void {
    const now = Date.now();
    for (const [token, state] of this.pending.entries()) {
      if (state.expiresAt < now) this.pending.delete(token);
    }
  }
}

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
