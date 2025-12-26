import { Context } from 'telegraf';
import { SalesCaseRepository } from '../../database/repository';
import { Logger } from '../../utils/logger';

interface CustomerInfo {
  name: string | null;
  phone: string | null;
  page: string | null;
  date: string;
  status_text: string | null;
}

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
      const leadEvents = await this.repository.getLeadEventsByFollowerAndMonth(follower, month);

      if (leadEvents.length === 0) {
        return `Customer List\nFollower: ${follower}\nMonth: ${this.formatMonth(month)}\n\nNo customers found.`;
      }

      // Deduplicate by phone (keep latest date + status_text)
      const customerMap = new Map<string, CustomerInfo>();

      for (const event of leadEvents) {
        const phone = event.customer.phone;

        // Skip events without phone number
        if (!phone) continue;

        const existing = customerMap.get(phone);

        // If no existing entry or this event is more recent, update
        if (!existing || event.date > existing.date) {
          customerMap.set(phone, {
            name: event.customer.name,
            phone: event.customer.phone,
            page: event.page,
            date: event.date,
            status_text: event.status_text
          });
        }
      }

      // Sort by date (latest first)
      const customers = Array.from(customerMap.values())
        .sort((a, b) => b.date.localeCompare(a.date));

      // Format output
      const header = [
        'Customer List',
        `Follower: ${follower}`,
        `Month: ${this.formatMonth(month)}`,
        `Total: ${customers.length}`,
        ''
      ].join('\n');

      const customerLines = customers.map((customer, index) => {
        const lines = [`${index + 1}) ${customer.name || 'Unknown'}`];

        if (customer.phone) {
          lines.push(`Phone: ${this.formatPhone(customer.phone)}`);
        }

        if (customer.page) {
          lines.push(`Page: ${customer.page}`);
        }

        lines.push(`Date: ${customer.date}`);

        if (customer.status_text) {
          lines.push(`Status: ${customer.status_text}`);
        }

        return lines.join('\n');
      });

      return header + customerLines.join('\n\n');

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
