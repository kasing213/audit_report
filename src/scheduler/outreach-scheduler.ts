import * as cron from 'node-cron';
import { Logger } from '../utils/logger';
import { generateBatch } from '../outreach/outreach-agent';

const DEFAULT_CRON = '0 9 * * *';
const DEFAULT_BATCH_LIMIT = 10;
const DEFAULT_STALE_DAYS = 45;
const DEFAULT_DAILY_DRAFT_BUDGET = 30;

type SendMessage = (chatId: string, text: string, extra?: any) => Promise<void>;

export class OutreachScheduler {
  private sendMessageCallback?: SendMessage;
  private draftsToday = 0;
  private draftsToday_day: string | null = null;

  public setNotifyCallback(callback: SendMessage): void {
    this.sendMessageCallback = callback;
  }

  public startScheduler(): void {
    if (process.env.OUTREACH_AUTO_SCAN !== 'true') {
      Logger.warn('Outreach auto-scan disabled (set OUTREACH_AUTO_SCAN=true to enable)');
      return;
    }

    const cronExpr = process.env.OUTREACH_CRON || DEFAULT_CRON;
    const tz = process.env.TIMEZONE || 'Asia/Kuala_Lumpur';

    cron.schedule(cronExpr, () => {
      Logger.info('Outreach scheduler tick');
      this.runScan().catch((err) => Logger.error('outreach scan tick failed', err as Error));
    }, {
      scheduled: true,
      timezone: tz,
    });

    Logger.info(`Outreach scheduler started (cron='${cronExpr}', tz='${tz}')`);
  }

  private dailyBudget(): number {
    const parsed = Number(process.env.OUTREACH_DAILY_DRAFT_BUDGET);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_DRAFT_BUDGET;
  }

  private rollDayCounter(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.draftsToday_day) {
      this.draftsToday_day = today;
      this.draftsToday = 0;
    }
  }

  private async runScan(): Promise<void> {
    this.rollDayCounter();

    const budget = this.dailyBudget();
    if (this.draftsToday >= budget) {
      Logger.info(`Outreach scan: daily draft budget (${budget}) already reached, skipping`);
      return;
    }

    const limitEnv = Number(process.env.OUTREACH_BATCH_LIMIT);
    const limit = Number.isFinite(limitEnv) && limitEnv > 0 ? limitEnv : DEFAULT_BATCH_LIMIT;
    const staleEnv = Number(process.env.OUTREACH_STALE_DAYS);
    const staleDays = Number.isFinite(staleEnv) && staleEnv > 0 ? staleEnv : DEFAULT_STALE_DAYS;

    const remaining = Math.max(0, budget - this.draftsToday);
    const effectiveLimit = Math.min(limit, remaining);
    if (effectiveLimit <= 0) {
      Logger.info('Outreach scan: no remaining budget, skipping');
      return;
    }

    try {
      const result = await generateBatch({ limit: effectiveLimit, staleDays });
      this.draftsToday += result.requested;

      Logger.info(
        `Outreach scan complete: requested=${result.requested} created=${result.created} skipped=${result.skipped} errored=${result.errored}`
      );

      const chatId = process.env.AUDIT_CHAT_ID || process.env.REPORT_CHAT_ID;
      if (chatId && this.sendMessageCallback) {
        const lines = [
          '📡 *Outreach scan*',
          '',
          `Requested: ${result.requested}`,
          `Created: ${result.created}`,
          `Skipped: ${result.skipped}`,
          `Errored: ${result.errored}`,
        ];
        try {
          await this.sendMessageCallback(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
        } catch (err) {
          Logger.error('Outreach scan summary send failed', err as Error);
        }
      }
    } catch (err) {
      Logger.error('Outreach scan failed', err as Error);
    }
  }
}
