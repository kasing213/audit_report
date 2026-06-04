import * as cron from 'node-cron';
import { Logger } from '../utils/logger';
import { OutreachWorkerStateRepository } from '../outreach/outreach-worker-state-repository';
import { notifyOutreachFailure } from '../outreach/outreach-alerts';

// Every 5 min, but only 09:00–21:59 — the hour range encodes the work-hours
// window so a laptop asleep overnight never produces a false "offline" alert.
const DEFAULT_CRON = '*/5 9-21 * * *';
const DEFAULT_STALE_MINUTES = 15;

/**
 * Watches the outreach worker's heartbeat (written to `outreach_worker_state`
 * every ~30s by the laptop worker) and fires a `worker-offline` alert when it
 * goes silent. Runs on the always-on Railway app because a laptop-side checker
 * can't detect its own death (asleep = checker asleep).
 *
 * Gated on HEARTBEAT_WATCHDOG_ENABLED=true. Reuses the existing alert sender
 * and its 30-min per-kind throttle, so at most one ping lands per half hour.
 */
export class HeartbeatWatchdogScheduler {
  private repo = new OutreachWorkerStateRepository();

  public startScheduler(): void {
    if (process.env.HEARTBEAT_WATCHDOG_ENABLED !== 'true') {
      Logger.warn('Heartbeat watchdog disabled (set HEARTBEAT_WATCHDOG_ENABLED=true to enable)');
      return;
    }

    const cronExpr = process.env.HEARTBEAT_WATCHDOG_CRON || DEFAULT_CRON;
    const tz = process.env.TIMEZONE || 'Asia/Kuala_Lumpur';

    cron.schedule(cronExpr, () => {
      this.check().catch((err) => Logger.error('heartbeat watchdog tick failed', err as Error));
    }, {
      scheduled: true,
      timezone: tz,
    });

    Logger.info(`Heartbeat watchdog started (cron='${cronExpr}', tz='${tz}')`);
  }

  private staleMinutes(): number {
    const parsed = Number(process.env.HEARTBEAT_STALE_MINUTES);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_MINUTES;
  }

  /** Force a check now (exposed for testing). */
  public async check(): Promise<void> {
    const state = await this.repo.getStatus();
    const last = state.last_heartbeat_at ? new Date(state.last_heartbeat_at).getTime() : null;
    const ageMin = last === null ? Infinity : (Date.now() - last) / 60000;
    const threshold = this.staleMinutes();

    if (ageMin <= threshold) {
      return; // fresh heartbeat — worker is alive
    }

    const reason = last === null ? 'no heartbeat on record' : `last heartbeat ${Math.round(ageMin)}m ago`;
    Logger.warn(`heartbeat watchdog: worker offline (${reason})`);

    const ctx: { reason: string; worker_id?: string; chatId?: string } = { reason };
    if (state.worker_id) ctx.worker_id = state.worker_id;
    if (process.env.WORKER_ALERT_CHAT_ID) ctx.chatId = process.env.WORKER_ALERT_CHAT_ID;
    await notifyOutreachFailure(null, 'worker-offline', ctx);
  }
}
