import * as cron from 'node-cron';
import { Logger } from '../utils/logger';
import { generateBatch } from '../outreach/outreach-agent';
import { OutreachRepository } from '../outreach/outreach-repository';
import { OutreachWorkerStateRepository } from '../outreach/outreach-worker-state-repository';
import { OUTREACH_ORGS, OrgId } from '../outreach/orgs';
import { OutreachScheduleSettingsRepository, ScheduleSettings, DEFAULT_SCHEDULE_SETTINGS } from '../outreach/outreach-schedule-settings-repository';
import { dailyCronAt, hourRangeCron, timeStrToMinutes } from '../utils/cron-time';

const DEFAULT_STALE_DAYS = 45;
/**
 * Ceiling on outstanding (pending + approved) proposals per workspace. The scan
 * tops the queue UP TO this number rather than adding this many, so a slow day
 * cannot accumulate a backlog — which matters because drafting is 20/day while
 * delivery is 15/day, and on Auto nobody is reviewing the pile.
 */
const DEFAULT_QUEUE_TARGET = 20;
// Mirrors DEFAULT_DAILY_CAP / DEFAULT_ATTEMPT_CAP in outreach-routes.ts — kept
// as separate local constants (same pattern as queueTarget/staleDays below)
// rather than imported, since both files read the same DAILY_CAP /
// DAILY_ATTEMPT_CAP env vars independently.
const DEFAULT_DAILY_CAP = 15;
const DEFAULT_ATTEMPT_CAP = 40;
/**
 * How many more proposals to draft+auto-approve when an Auto workspace has
 * exhausted its approved queue without reaching the day's delivery cap —
 * e.g. the day's 20 drafted at 9am mostly bounced (privacy/invalid), so the
 * worker ran dry at 6/15 delivered. Deliberately smaller than the initial
 * queue target so a bad-luck day escalates gradually rather than dumping
 * another 20 at once.
 */
const DEFAULT_TOPUP_INCREMENT = 10;
// How often the top-up check runs within the active-hours window (itself
// dashboard-editable — see OutreachScheduleSettingsRepository). Overlapping
// the daily scan tick is harmless: the top-up no-ops whenever the scan
// already left something in 'approved'.
const DEFAULT_TOPUP_INTERVAL_MIN = 30;

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
  private scanTask: cron.ScheduledTask | null = null;
  private topupTask: cron.ScheduledTask | null = null;
  private enabled = false;
  private currentSettings: ScheduleSettings = DEFAULT_SCHEDULE_SETTINGS;

  public setNotifyCallback(callback: SendMessage): void {
    this.sendMessageCallback = callback;
  }

  /** The schedule settings currently driving the live cron jobs. */
  public getCurrentSettings(): ScheduleSettings {
    return this.currentSettings;
  }

  /** Force a scan tick now (used by /scheduler/run-once for testing). */
  public async triggerNow(): Promise<void> {
    await this.runScan();
  }

  /** Force a top-up check now (used by /scheduler/topup-once for testing). */
  public async triggerTopUpNow(): Promise<void> {
    await this.runTopUpCheck();
  }

  public startScheduler(): void {
    registeredScheduler = this;

    if (process.env.OUTREACH_AUTO_SCAN !== 'true') {
      Logger.warn('Outreach auto-scan disabled (set OUTREACH_AUTO_SCAN=true to enable)');
      return;
    }

    this.enabled = true;
    new OutreachScheduleSettingsRepository()
      .getEffective()
      .then((settings) => this.applySchedule(settings))
      .catch((err) => Logger.error('outreach scheduler initial settings load failed', err as Error));
  }

  /**
   * (Re)builds the scan + top-up cron jobs from the given settings, replacing
   * whatever was previously scheduled. Called once at startup and again every
   * time the dashboard saves a schedule change (POST
   * /crm/api/outreach/schedule-settings) — no redeploy needed to move times.
   * No-ops if OUTREACH_AUTO_SCAN never enabled the scheduler in the first
   * place, since there is nothing running to reschedule.
   */
  public applySchedule(settings: ScheduleSettings): void {
    if (!this.enabled) return;
    this.currentSettings = settings;
    this.scanTask?.stop();
    this.topupTask?.stop();

    const tz = process.env.TIMEZONE || 'Asia/Phnom_Penh';
    const cronExpr = dailyCronAt(settings.scan_time);
    const topupCronExpr = hourRangeCron(settings.active_start_hour, settings.active_end_hour, this.topupInterval());

    this.scanTask = cron.schedule(cronExpr, () => {
      Logger.info('Outreach scheduler tick');
      this.runScan().catch((err) => Logger.error('outreach scan tick failed', err as Error));
    }, {
      scheduled: true,
      timezone: tz,
    });

    this.topupTask = cron.schedule(topupCronExpr, () => {
      this.runTopUpCheck().catch((err) => Logger.error('outreach top-up tick failed', err as Error));
    }, {
      scheduled: true,
      timezone: tz,
    });

    Logger.info(`Outreach scheduler (re)scheduled (cron='${cronExpr}', topup_cron='${topupCronExpr}', tz='${tz}')`);
  }

  private topupInterval(): number {
    const parsed = Number(process.env.OUTREACH_TOPUP_INTERVAL_MIN);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOPUP_INTERVAL_MIN;
  }

  /**
   * Whether today's scan_time has already passed, in the scheduler's
   * timezone. Uses formatToParts rather than a locale-formatted hour string —
   * some ICU locales render midnight as "24:00" under hour12:false, which
   * would corrupt the HH:MM parse below.
   */
  private isPastScanTimeToday(): boolean {
    const tz = process.env.TIMEZONE || 'Asia/Phnom_Penh';
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return timeStrToMinutes(`${hour}:${minute}`) >= timeStrToMinutes(this.currentSettings.scan_time);
  }

  private queueTarget(): number {
    const parsed = Number(process.env.OUTREACH_QUEUE_TARGET);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QUEUE_TARGET;
  }

  private staleDays(): number {
    const parsed = Number(process.env.OUTREACH_STALE_DAYS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_DAYS;
  }

  private dailyCap(): number {
    const parsed = Number(process.env.DAILY_CAP);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_CAP;
  }

  private attemptCap(): number {
    const parsed = Number(process.env.DAILY_ATTEMPT_CAP);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return Math.max(DEFAULT_ATTEMPT_CAP, this.dailyCap());
  }

  private topupIncrement(): number {
    const parsed = Number(process.env.OUTREACH_TOPUP_INCREMENT);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOPUP_INCREMENT;
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

  /**
   * Mid-day self-heal for Auto workspaces: if the day's delivery cap hasn't
   * been reached AND the approved queue has run dry (e.g. most of the 9am
   * batch bounced as privacy/invalid), draft+auto-approve another
   * topupIncrement() so the worker has something to keep sending. Repeats on
   * every tick — each call only adds once the previous increment is fully
   * consumed — so a bad day escalates 20 -> 30 -> 40 rather than dumping a
   * huge batch at once. One org failing must not stop the others.
   */
  private async runTopUpCheck(): Promise<void> {
    for (const org of OUTREACH_ORGS) {
      try {
        await this.runTopUpCheckForOrg(org.id);
      } catch (err) {
        Logger.error(`Outreach top-up check failed for org=${org.id}`, err as Error);
      }
    }
  }

  private async runTopUpCheckForOrg(orgId: OrgId): Promise<void> {
    // The top-up window can open before scan_time (e.g. scan moved to 12:55
    // but active_start_hour is still 9) — without this, an empty queue before
    // today's scan has even run would read as "ran dry" and draft early,
    // defeating a deliberately-delayed scan_time. Only self-heal AFTER the
    // scan that was supposed to seed the day's queue has actually had its
    // chance to run.
    if (!this.isPastScanTimeToday()) return;

    const state = await new OutreachWorkerStateRepository().getStatus(orgId);
    // Manual workspaces are intentionally excluded: piling another batch of
    // pending onto the dashboard every 30 minutes would spam the operator
    // instead of helping them. Only Auto workspaces self-heal mid-day.
    if (!state.auto_approve || state.paused) return;

    const dCap = this.dailyCap();
    const aCap = this.attemptCap();
    if (state.deliveries_today >= dCap) return; // day's target already met
    if (state.claims_today >= aCap) return; // no attempt budget left today

    const counts = await new OutreachRepository().counts(orgId);
    if (counts.approved > 0) return; // worker still has something to claim

    const draftCount = Math.min(this.topupIncrement(), aCap - state.claims_today);
    if (draftCount <= 0) return;

    const result = await generateBatch({
      limit: draftCount,
      staleDays: this.staleDays(),
      autoApprove: true,
      orgId,
    });

    Logger.info(
      `Outreach top-up org=${orgId}: deliveries=${state.deliveries_today}/${dCap} ` +
      `claims=${state.claims_today}/${aCap} drafted=${draftCount} created=${result.created}`
    );

    const chatId = process.env.AUDIT_CHAT_ID || process.env.REPORT_CHAT_ID;
    if (result.created > 0 && chatId && this.sendMessageCallback) {
      const lines = [
        `🔁 *Outreach top-up* — ${orgId}`,
        '',
        `Delivered so far: ${state.deliveries_today}/${dCap}`,
        `Approved queue ran dry — drafted ${result.created} more (auto-approved)`,
      ];
      try {
        await this.sendMessageCallback(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      } catch (err) {
        Logger.error('Outreach top-up summary send failed', err as Error);
      }
    }
  }
}
