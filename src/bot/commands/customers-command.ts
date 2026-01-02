import { Context } from 'telegraf';
import { SalesCaseRepository } from '../../database/repository';
import { Logger } from '../../utils/logger';
import { formatReasonDisplay } from '../../constants/reason-codes';

export class CustomersCommand {
  private repository: SalesCaseRepository;
  private pendingCustomersRequest: Map<number, {
    chatId: number;
    expiresAt: number;
    step: 'awaiting_follower' | 'awaiting_month';
    follower?: string;
  }>;
  private lastRequestAt: Map<number, number>;
  private cooldownMs: number;

  constructor(repository: SalesCaseRepository) {
    this.repository = repository;
    this.pendingCustomersRequest = new Map();
    this.lastRequestAt = new Map();
    this.cooldownMs = 2 * 60 * 1000; // 2 minutes
  }

  async handleCommand(ctx: Context): Promise<void> {
    const userId = ctx.from?.id || 0;

    // Check rate limit
    const lastRequest = this.lastRequestAt.get(userId);
    if (lastRequest) {
      const timeSinceLastRequest = Date.now() - lastRequest;
      if (timeSinceLastRequest < this.cooldownMs) {
        const waitSeconds = Math.ceil((this.cooldownMs - timeSinceLastRequest) / 1000);
        await ctx.reply(`Please wait ${waitSeconds}s before requesting another customer list.`);
        return;
      }
    }

    // Start conversation flow
    this.pendingCustomersRequest.set(userId, {
      chatId: ctx.chat?.id as number,
      expiresAt: Date.now() + 5 * 60 * 1000,  // 5 minutes timeout
      step: 'awaiting_follower'
    });

    await ctx.reply('Which follower? (example: Srey Sros)');
  }

  async handlePendingRequest(ctx: Context, text: string): Promise<boolean> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!userId || chatId === undefined) {
      return false;
    }

    const pending = this.pendingCustomersRequest.get(userId);
    if (!pending) {
      return false;
    }

    // Check expiration
    if (pending.chatId !== chatId || pending.expiresAt < Date.now()) {
      this.pendingCustomersRequest.delete(userId);
      return false;
    }

    try {
      if (pending.step === 'awaiting_follower') {
        // Store follower name and move to next step
        pending.follower = text.trim();
        pending.step = 'awaiting_month';
        this.pendingCustomersRequest.set(userId, pending);

        await ctx.reply('Which month? (YYYY-MM or type "current")');
        return true;
      }

      if (pending.step === 'awaiting_month') {
        // Parse month input
        const month = this.parseMonthInput(text.trim());
        if (!month) {
          await ctx.reply('Invalid month format. Please use YYYY-MM or type "current".');
          return true;
        }

        // Generate and send report
        const reply = await this.buildCustomersReport(pending.follower!, month);
        await ctx.reply(reply);

        // Update rate limit timestamp
        this.lastRequestAt.set(userId, Date.now());

        // Clean up
        this.pendingCustomersRequest.delete(userId);
        return true;
      }

    } catch (error) {
      Logger.error('Error handling customers command flow', error as Error);
      await ctx.reply('Failed to generate customer list.');
      this.pendingCustomersRequest.delete(userId);
      return true;
    }

    return false;
  }

  private parseMonthInput(input: string): string | null {
    if (input.toLowerCase() === 'current') {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      return `${year}-${month}`;
    }

    // Validate YYYY-MM format
    if (/^\d{4}-\d{2}$/.test(input)) {
      return input;
    }

    return null;
  }

  private async buildCustomersReport(follower: string, month: string): Promise<string> {
    try {
      const cases = await this.repository.getCasesByFollowerAndMonth(follower, month);

      if (cases.length === 0) {
        return `Customer List\nFollower: ${follower}\nMonth: ${this.formatMonth(month)}\n\nNo cases found.`;
      }

      // Format output
      const header = [
        'Customer List',
        `Follower: ${follower}`,
        `Month: ${this.formatMonth(month)}`,
        `Total Cases: ${cases.length}`,
        ''
      ].join('\n');

      const caseLines = cases.map((c, index) => {
        const lines = [`${index + 1}) ${c.name || 'Unknown'}`];

        if (c.phone) {
          lines.push(`   Phone: ${this.formatPhone(c.phone)}`);
        }

        if (c.page) {
          lines.push(`   Page: ${c.page}`);
        }

        lines.push(`   First contact: ${c.first_contact_date}`);

        if (c.last_update_date !== c.first_contact_date) {
          lines.push(`   Last update: ${c.last_update_date}`);
        }

        if (c.current_status || c.current_reason_code) {
          lines.push(`   Current status: ${formatReasonDisplay(c.current_reason_code ?? null, c.current_status)}`);
        }

        lines.push(`   Updates: ${c.total_events} event${c.total_events > 1 ? 's' : ''}`);

        return lines.join('\n');
      });

      return header + caseLines.join('\n\n');

    } catch (error) {
      Logger.error('Error building customers report', error as Error);
      throw error;
    }
  }

  private formatMonth(month: string): string {
    // Convert YYYY-MM to "Month YYYY"
    const [year, monthNum] = month.split('-');
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const monthIndex = parseInt(monthNum, 10) - 1;
    return `${monthNames[monthIndex]} ${year}`;
  }

  private formatPhone(phone: string): string {
    // Format phone number with spaces: "093724678" -> "093 724 678"
    if (phone.length === 9) {
      return `${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6)}`;
    }
    if (phone.length === 10) {
      return `${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6)}`;
    }
    return phone;
  }

  isPendingRequest(userId: number): boolean {
    return this.pendingCustomersRequest.has(userId);
  }

  clearPendingRequest(userId: number): void {
    this.pendingCustomersRequest.delete(userId);
  }
}
