import * as cron from 'node-cron';
import { Logger } from '../utils/logger';
import { OutreachWorkerStateRepository } from '../outreach/outreach-worker-state-repository';
import { notifyOutreachFailure } from '../outreach/outreach-alerts';
import { OUTREACH_ORGS } from '../outreach/orgs';
import { OutreachScheduleSettingsRepository } from '../outreach/outreach-schedule-settings-repository';
import { hourRangeCron } from '../utils/cron-time';

const DEFAULT_WATCHDOG_INTERVAL_MIN = 5;
const DEFAULT_STALE_MINUTES = 15;

let registeredWatchdog: HeartbeatWatchdogScheduler | null = null;

export function getRegisteredHeartbeatWatchdogScheduler(): HeartbeatWatchdogScheduler | null {
  return registeredWatchdog;
}

/**
 * Watches the outreach worker's heartbeat (written to `outreach_worker_state`
 * every ~30s by the laptop worker) and fires a `worker-offline` alert when it
 * goes silent. Runs on the always-on Railway app because a laptop-side checker
 * can't detect its own death (asleep = checker asleep).
 *
 * Only checks within the dashboard-editable active-hours window (shared with
 * OutreachScheduler's top-up check — see OutreachScheduleSettingsRepository),
 * so a laptop asleep overnight never produces a false "offline" alert.
 *
 * Gated on HEARTBEAT_WATCHDOG_ENABLED=true. Reuses the existing alert sender
 * and its 30-min per-kind throttle, so at most one ping lands per half hour.
 */
export class HeartbeatWatchdogScheduler {
  private repo = new OutreachWorkerStateRepository();
  private task: cron.ScheduledTask | null = null;
  private enabled = false;

  public startScheduler(): void {
    registeredWatchdog = this;

    if (process.env.HEARTBEAT_WATCHDOG_ENABLED !== 'true') {
      Logger.warn('Heartbeat watchdog disabled (set HEARTBEAT_WATCHDOG_ENABLED=true to enable)');
      return;
    }

    this.enabled = true;
    new OutreachScheduleSettingsRepository()
      .getEffective()
      .then((settings) => this.applySchedule(settings.active_start_hour, settings.active_end_hour))
      .catch((err) => Logger.error('heartbeat watchdog initial settings load failed', err as Error));
  }

  /**
   * (Re)builds the watchdog cron job from the active-hours window. Called at
   * startup and again whenever the dashboard saves a schedule change. No-op
   * if HEARTBEAT_WATCHDOG_ENABLED never turned this scheduler on.
   */
  public applySchedule(activeStartHour: number, activeEndHour: number): void {
    if (!this.enabled) return;
    this.task?.stop();

    const cronExpr = hourRangeCron(activeStartHour, activeEndHour, this.watchdogInterval());
    const tz = process.env.TIMEZONE || 'Asia/Phnom_Penh';

    this.task = cron.schedule(cronExpr, () => {
      this.check().catch((err) => Logger.error('heartbeat watchdog tick failed', err as Error));
    }, {
      scheduled: true,
      timezone: tz,
    });

    Logger.info(`Heartbeat watchdog (re)scheduled (cron='${cronExpr}', tz='${tz}')`);
  }

  private watchdogInterval(): number {
    const parsed = Number(process.env.HEARTBEAT_WATCHDOG_INTERVAL_MIN);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WATCHDOG_INTERVAL_MIN;
  }

  private staleMinutes(): number {
    const parsed = Number(process.env.HEARTBEAT_STALE_MINUTES);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_MINUTES;
  }

  /** Force a check now (exposed for testing). Checks every org independently. */
  public async check(): Promise<void> {
    const threshold = this.staleMinutes();
    for (const org of OUTREACH_ORGS) {
      await this.checkOrg(org.id, threshold);
    }
  }

  private async checkOrg(orgId: string, threshold: number): Promise<void> {
    const state = await this.repo.getStatus(orgId);

    // An org whose worker has NEVER heartbeated is "not set up", not "offline" —
    // skip it so an org the operator doesn't run (e.g. personal before it's
    // started) never false-alarms. It enrolls in the watchdog on its 1st beat.
    if (!state.last_heartbeat_at) return;

    const ageMin = (Date.now() - new Date(state.last_heartbeat_at).getTime()) / 60000;
    if (ageMin <= threshold) {
      return; // fresh heartbeat — this org's worker is alive
    }

    const reason = `last heartbeat ${Math.round(ageMin)}m ago`;
    Logger.warn(`heartbeat watchdog: ${orgId} worker offline (${reason})`);

    const ctx: { reason: string; worker_id?: string; chatId?: string; org: string } = { reason, org: orgId };
    if (state.worker_id) ctx.worker_id = state.worker_id;
    if (process.env.WORKER_ALERT_CHAT_ID) ctx.chatId = process.env.WORKER_ALERT_CHAT_ID;
    await notifyOutreachFailure(null, 'worker-offline', ctx);
  }
}
