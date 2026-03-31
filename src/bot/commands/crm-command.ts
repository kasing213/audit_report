import { Context, Markup } from 'telegraf';
import { SalesCaseRepository } from '../../database/repository';
import { CustomerCase } from '../../database/models';
import { formatTelegramLink, formatPhoneDisplay } from '../../utils/phone-utils';
import { formatReasonDisplay } from '../../constants/reason-codes';
import { Logger } from '../../utils/logger';

const PAGE_SIZE = 10;

interface PendingCrmRequest {
  chatId: number;
  expiresAt: number;
  step: 'awaiting_follower' | 'awaiting_filter';
  follower?: string;
}

export class CrmCommand {
  private repository: SalesCaseRepository;
  private pendingRequests: Map<number, PendingCrmRequest> = new Map();
  private lastRequestAt: Map<number, number> = new Map();
  private cooldownMs = 2 * 60 * 1000;

  constructor(repository: SalesCaseRepository) {
    this.repository = repository;
  }

  async handleCommand(ctx: Context): Promise<void> {
    const userId = ctx.from?.id || 0;

    const lastRequest = this.lastRequestAt.get(userId);
    if (lastRequest && Date.now() - lastRequest < this.cooldownMs) {
      const waitSeconds = Math.ceil((this.cooldownMs - (Date.now() - lastRequest)) / 1000);
      await ctx.reply(`Please wait ${waitSeconds}s before another CRM lookup.`);
      return;
    }

    this.pendingRequests.set(userId, {
      chatId: ctx.chat?.id as number,
      expiresAt: Date.now() + 5 * 60 * 1000,
      step: 'awaiting_follower'
    });

    await ctx.reply('👤 Which follower? (name or "all")');
  }

  async handlePending(ctx: Context, text: string): Promise<boolean> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || chatId === undefined) return false;

    const pending = this.pendingRequests.get(userId);
    if (!pending) return false;

    if (pending.chatId !== chatId || pending.expiresAt < Date.now()) {
      this.pendingRequests.delete(userId);
      return false;
    }

    try {
      if (pending.step === 'awaiting_follower') {
        pending.follower = text.trim();
        pending.step = 'awaiting_filter';
        this.pendingRequests.set(userId, pending);
        await ctx.reply(
          '🔍 Filter type?\n\n' +
          '• Type "all" — all customers\n' +
          '• Type "stale" — no contact >14 days\n' +
          '• Type a reason code (A-J) — filter by reason',
          Markup.keyboard([['all', 'stale'], ['A', 'B', 'C', 'D', 'E'], ['F', 'G', 'H', 'I', 'J']]).resize()
        );
        return true;
      }

      if (pending.step === 'awaiting_filter') {
        const filterInput = text.trim().toLowerCase();
        const follower = pending.follower === 'all' ? undefined : pending.follower;

        let cases: CustomerCase[];
        let filterLabel: string;

        if (filterInput === 'all') {
          cases = await this.repository.getAllCustomers(follower);
          filterLabel = 'All Customers';
        } else if (filterInput === 'stale') {
          cases = await this.repository.getStaleCustomers(14, follower);
          filterLabel = 'Stale (>14 days)';
        } else if (/^[a-j]$/i.test(filterInput)) {
          const reasonCode = filterInput.toUpperCase();
          cases = await this.repository.getCustomersByReason(reasonCode, follower);
          filterLabel = `Reason: ${reasonCode}`;
        } else {
          await ctx.reply('❌ Invalid filter. Type "all", "stale", or a reason code A-J.');
          return true;
        }

        await this.sendResults(ctx, cases, pending.follower || 'All', filterLabel);

        this.lastRequestAt.set(userId, Date.now());
        this.pendingRequests.delete(userId);
        return true;
      }
    } catch (error) {
      Logger.error('Error handling CRM command flow', error as Error);
      await ctx.reply('❌ Failed to fetch CRM data.', Markup.removeKeyboard());
      this.pendingRequests.delete(userId);
      return true;
    }

    return false;
  }

  private async sendResults(ctx: Context, cases: CustomerCase[], follower: string, filterLabel: string): Promise<void> {
    if (cases.length === 0) {
      await ctx.reply(
        `📋 CRM — ${follower} | ${filterLabel}\n\nNo customers found.`,
        Markup.removeKeyboard()
      );
      return;
    }

    const header = `📋 <b>CRM — ${this.escapeHtml(follower)} | ${this.escapeHtml(filterLabel)}</b>\nTotal: ${cases.length}\n`;

    // Paginate
    const pages = Math.ceil(cases.length / PAGE_SIZE);
    const firstPage = cases.slice(0, PAGE_SIZE);
    const body = this.formatPage(firstPage, 0);

    await ctx.reply(header + '\n' + body, {
      parse_mode: 'HTML',
      ...Markup.removeKeyboard()
    });

    if (pages > 1) {
      await ctx.reply(`Showing 1-${Math.min(PAGE_SIZE, cases.length)} of ${cases.length}. Use the dashboard for full browsing.`);
    }
  }

  private formatPage(cases: CustomerCase[], offset: number): string {
    return cases.map((c, i) => {
      const idx = offset + i + 1;
      const name = c.name || 'Unknown';
      const phoneLine = c.phone
        ? `   📞 <a href="${formatTelegramLink(c.phone)}">${this.escapeHtml(formatPhoneDisplay(c.phone))}</a>`
        : '';
      const meta: string[] = [];
      if (c.page) meta.push(c.page);
      if (c.last_update_date) meta.push(`Last: ${c.last_update_date}`);
      const metaLine = meta.length ? `   📄 ${this.escapeHtml(meta.join(' | '))}` : '';
      const reasonLine = c.current_reason_code
        ? `   📋 ${this.escapeHtml(formatReasonDisplay(c.current_reason_code))}`
        : '';

      return [`${idx}) <b>${this.escapeHtml(name)}</b>`, phoneLine, metaLine, reasonLine]
        .filter(Boolean)
        .join('\n');
    }).join('\n\n');
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  isPending(userId: number): boolean {
    return this.pendingRequests.has(userId);
  }

  clearPending(userId: number): void {
    this.pendingRequests.delete(userId);
  }
}
