import * as cron from 'node-cron';
import { Logger } from '../utils/logger';
import { generateBatch } from '../outreach/outreach-agent';
import { OutreachRepository } from '../outreach/outreach-repository';
import { OutreachWorkerStateRepository } from '../outreach/outreach-worker-state-repository';
import { OUTREACH_ORGS, OrgId } from '../outreach/orgs';

const DEFAULT_CRON = '0 9 * * *';
const DEFAULT_STALE_DAYS = 45;
/**
 * Ceiling on outstanding (pending + approved) proposals per workspace. The scan
 * tops the queue UP TO this number rather than adding this many, so a slow day
 * cannot accumulate a backlog — which matters because drafting is 20/day while
 * delivery is 15/day, and on Auto nobody is reviewing the pile.
 */
const DEFAULT_QUEUE_TARGET = 20;

type SendMessage = (chatId: string, text: string, extra?: any) => Promise<void>;

let registeredScheduler: OutreachScheduler | null = null;

export function getRegisteredOutreachScheduler(): OutreachScheduler | null {
  return registeredScheduler;
}

/**
 * The scan's top-up rule, extracted as a pure function so it can be asserted
 * directly (see scripts/check-scan-topup.js) instead of only through the
 * scheduler's side-effecting runScanForOrg. Tops the queue UP TO `target`
 * rather than adding `target` — with N outstanding it drafts max(0, target-N).
 */
export function computeDraftCount(outstanding: number, target: number): number {
  return Math.max(0, target - outstanding);
}

export class OutreachScheduler {
  private sendMessageCallback?: SendMessage;

  public setNotifyCallback(callback: SendMessage): void {
    this.sendMessageCallback = callback;
  }

  /** Force a scan tick now (used by /scheduler/run-once for testing). */
  public async triggerNow(): Promise<void> {
    await this.runScan();
  }

  public startScheduler(): void {
    registeredScheduler = this;

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

  private queueTarget(): number {
    const parsed = Number(process.env.OUTREACH_QUEUE_TARGET);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QUEUE_TARGET;
  }

  private staleDays(): number {
    const parsed = Number(process.env.OUTREACH_STALE_DAYS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_DAYS;
  }

  /**
   * Scan every workspace. One org failing must not stop the others.
   * NOTE: OUTREACH_ORGS is OrgDef[] ({ id, label }), not a string array — iterate
   * the objects and pass `.id`.
   */
  private async runScan(): Promise<void> {
    for (const org of OUTREACH_ORGS) {
      try {
        await this.runScanForOrg(org.id);
      } catch (err) {
        Logger.error(`Outreach scan failed for org=${org.id}`, err as Error);
      }
    }
  }

  private async runScanForOrg(orgId: OrgId): Promise<void> {
    const target = this.queueTarget();
    const outstanding = await new OutreachRepository().countOutstanding(orgId);
    const draftCount = computeDraftCount(outstanding, target);

    if (draftCount === 0) {
      Logger.info(`Outreach scan org=${orgId}: queue already at ${outstanding}/${target}, drafting 0`);
      return;
    }

    // Approval mode is per workspace and read fresh each tick, so flipping the
    // dashboard switch takes effect on the very next scan.
    const state = await new OutreachWorkerStateRepository().getStatus(orgId);
    const autoApprove = state.auto_approve === true;

    const result = await generateBatch({
      limit: draftCount,
      staleDays: this.staleDays(),
      autoApprove,
      orgId,
    });

    Logger.info(
      `Outreach scan org=${orgId} mode=${autoApprove ? 'auto' : 'manual'}: ` +
      `outstanding=${outstanding} target=${target} drafted=${draftCount} ` +
      `created=${result.created} skipped=${result.skipped} errored=${result.errored}`
    );

    const chatId = process.env.AUDIT_CHAT_ID || process.env.REPORT_CHAT_ID;
    if (chatId && this.sendMessageCallback) {
      const lines = [
        `📡 *Outreach scan* — ${orgId}`,
        '',
        `Mode: ${autoApprove ? 'AUTO approve' : 'manual approve'}`,
        `Queue before: ${outstanding}/${target}`,
        `Drafted: ${result.created}`,
        `Skipped: ${result.skipped}`,
        `Errored: ${result.errored}`,
      ];
      try {
        await this.sendMessageCallback(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      } catch (err) {
        Logger.error('Outreach scan summary send failed', err as Error);
      }
    }
  }
}
