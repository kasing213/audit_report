import { Context } from 'telegraf';
import { SalesCaseRepository } from '../../database/repository';
import { CustomerCase } from '../../database/models';
import { formatTelegramLink, formatPhoneDisplay } from '../../utils/phone-utils';
import { Temperature, TEMPERATURE_EMOJIS, TEMPERATURE_LABELS } from '../../constants/temperature';
import { Logger } from '../../utils/logger';

const PAGE_SIZE = 15;

export class TemperatureCommand {
  private repository: SalesCaseRepository;
  private lastRequestAt: Map<number, number> = new Map();
  private cooldownMs = 2 * 60 * 1000;

  constructor(repository: SalesCaseRepository) {
    this.repository = repository;
  }

  async handleCommand(ctx: Context, temperature: Temperature): Promise<void> {
    const userId = ctx.from?.id || 0;

    const lastRequest = this.lastRequestAt.get(userId);
    if (lastRequest && Date.now() - lastRequest < this.cooldownMs) {
      const waitSeconds = Math.ceil((this.cooldownMs - (Date.now() - lastRequest)) / 1000);
      await ctx.reply(`Please wait ${waitSeconds}s before another lookup.`);
      return;
    }

    // Optional follower argument from command text, e.g. "/hot SreySros"
    const messageText = (ctx.message && 'text' in ctx.message) ? ctx.message.text : '';
    const parts = messageText.trim().split(/\s+/);
    const follower = parts.length > 1 ? parts.slice(1).join(' ') : undefined;

    try {
      const cases = await this.repository.getCustomersByTemperatureAndMonth(
        temperature,
        'current',
        follower
      );
      this.lastRequestAt.set(userId, Date.now());
      await this.sendResults(ctx, cases, temperature, follower);
    } catch (error) {
      Logger.error(`Error handling /${temperature} command`, error as Error);
      await ctx.reply(`❌ Failed to fetch ${temperature} customers.`);
    }
  }

  private async sendResults(
    ctx: Context,
    cases: CustomerCase[],
    temperature: Temperature,
    follower?: string
  ): Promise<void> {
    const emoji = TEMPERATURE_EMOJIS[temperature];
    const label = TEMPERATURE_LABELS[temperature];
    const scope = follower ? `👤 ${this.escapeHtml(follower)}` : 'All followers';
    const monthLabel = new Date().toISOString().slice(0, 7);

    if (cases.length === 0) {
      await ctx.reply(
        `${emoji} <b>${label} leads</b> — ${scope} (${monthLabel})\n\nNo customers found.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const header = `${emoji} <b>${label} leads</b> — ${scope} (${monthLabel})\nTotal: ${cases.length}\n`;
    const firstPage = cases.slice(0, PAGE_SIZE);
    const body = this.formatPage(firstPage, 0);

    await ctx.reply(header + '\n' + body, { parse_mode: 'HTML' });

    if (cases.length > PAGE_SIZE) {
      await ctx.reply(
        `Showing 1–${PAGE_SIZE} of ${cases.length}. Use the dashboard for full browsing.`
      );
    }
  }

  private formatPage(cases: CustomerCase[], offset: number): string {
    return cases
      .map((c, i) => {
        const idx = offset + i + 1;
        const name = c.name || 'Unknown';
        const phoneLine = c.phone
          ? `   📞 <a href="${formatTelegramLink(c.phone)}">${this.escapeHtml(formatPhoneDisplay(c.phone))}</a>`
          : '';
        const meta: string[] = [];
        if (c.follower) meta.push(`👤 ${c.follower}`);
        if (c.page) meta.push(c.page);
        if (c.last_update_date) meta.push(`Last: ${c.last_update_date}`);
        const metaLine = meta.length ? `   ${this.escapeHtml(meta.join(' | '))}` : '';
        const statusLine = c.current_status
          ? `   📝 ${this.escapeHtml(c.current_status)}`
          : '';

        return [`${idx}) <b>${this.escapeHtml(name)}</b>`, phoneLine, metaLine, statusLine]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
