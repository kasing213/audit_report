/**
 * Operator-editable schedule times for the outreach system — one doc, global
 * (not per-org: the scan/top-up/watchdog crons already loop over every org on
 * a single shared tick, and the Mac worker's bounce time is one machine
 * serving both org processes). Lets the dashboard move "9am scan" / "8:30
 * bounce" / the active-hours window without a code change + redeploy.
 *
 * Consumers:
 *   - OutreachScheduler / HeartbeatWatchdogScheduler (Railway) rebuild their
 *     node-cron expressions from this on startup and whenever the dashboard
 *     saves a change (see applySchedule() on each).
 *   - The Mac worker (scripts/telegram-worker/worker.ts) polls bounce_time
 *     via GET /crm/api/outreach/schedule-settings (agent-role allowed) and
 *     self-exits once per day at that time instead of relying on pm2's
 *     cron_restart, which has no way to read this DB.
 */
import { Collection } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { isValidTimeStr, isValidHour, timeStrToMinutes } from '../utils/cron-time';

export interface ScheduleSettings {
  scan_time: string;        // 'HH:MM' Cambodia — daily draft/scan
  bounce_time: string;      // 'HH:MM' Cambodia — Mac worker daily self-restart
  active_start_hour: number; // top-up + watchdog window opens (whole hour)
  active_end_hour: number;   // window closes, inclusive (whole hour)
}

interface OutreachScheduleSettingsDocument extends ScheduleSettings {
  _id: string;
  updated_at: Date;
  updated_by: string;
}

const COLLECTION = 'outreach_schedule_settings';
const DOC_ID = 'schedule';

// Mirrors the values fixed by the 2026-08-01 Cambodia-timezone design doc:
// bounce (08:30) strictly precedes both the scan (09:00) and the watchdog
// window open (09:00), so a restart's heartbeat gap never raises a false
// worker-offline alert. Guarded by scripts/check-bounce-precedes-scan.js.
export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  scan_time: '12:55',
  bounce_time: '08:30',
  active_start_hour: 9,
  active_end_hour: 21,
};

export class OutreachScheduleSettingsRepository {
  private col: Collection<OutreachScheduleSettingsDocument>;

  constructor() {
    const db = DatabaseConnection.getInstance().getDb();
    this.col = db.collection<OutreachScheduleSettingsDocument>(COLLECTION);
  }

  /** Saved overrides merged onto the defaults — never partially-missing. */
  async getEffective(): Promise<ScheduleSettings> {
    const doc = await this.col.findOne({ _id: DOC_ID });
    if (!doc) return { ...DEFAULT_SCHEDULE_SETTINGS };
    return {
      scan_time: isValidTimeStr(doc.scan_time) ? doc.scan_time : DEFAULT_SCHEDULE_SETTINGS.scan_time,
      bounce_time: isValidTimeStr(doc.bounce_time) ? doc.bounce_time : DEFAULT_SCHEDULE_SETTINGS.bounce_time,
      active_start_hour: isValidHour(doc.active_start_hour) ? doc.active_start_hour : DEFAULT_SCHEDULE_SETTINGS.active_start_hour,
      active_end_hour: isValidHour(doc.active_end_hour) ? doc.active_end_hour : DEFAULT_SCHEDULE_SETTINGS.active_end_hour,
    };
  }

  /** Validates, merges onto the current effective settings, and persists. */
  async set(update: Partial<ScheduleSettings>, updatedBy: string): Promise<ScheduleSettings> {
    const current = await this.getEffective();
    const next: ScheduleSettings = { ...current, ...update };

    if (!isValidTimeStr(next.scan_time)) throw new Error(`invalid scan_time: ${next.scan_time}`);
    if (!isValidTimeStr(next.bounce_time)) throw new Error(`invalid bounce_time: ${next.bounce_time}`);
    if (!isValidHour(next.active_start_hour)) throw new Error(`invalid active_start_hour: ${next.active_start_hour}`);
    if (!isValidHour(next.active_end_hour)) throw new Error(`invalid active_end_hour: ${next.active_end_hour}`);
    if (next.active_start_hour > next.active_end_hour) {
      throw new Error('active_start_hour must not be after active_end_hour');
    }
    // A bounce inside (or after) the active window can restart the worker
    // right as the heartbeat watchdog is checking, opening a gap that reads
    // as worker-offline — the exact bug the 2026-08-01 design doc fixed.
    if (timeStrToMinutes(next.bounce_time) >= next.active_start_hour * 60) {
      throw new Error(
        `bounce_time (${next.bounce_time}) must be before the active-hours window starts ` +
        `(${String(next.active_start_hour).padStart(2, '0')}:00) — a later bounce can raise a false worker-offline alert`
      );
    }

    await this.col.updateOne(
      { _id: DOC_ID },
      { $set: { ...next, updated_at: new Date(), updated_by: updatedBy } },
      { upsert: true }
    );
    return next;
  }
}
