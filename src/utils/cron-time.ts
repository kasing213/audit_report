/**
 * Build node-cron expressions from operator-friendly HH:MM / hour values.
 * Shared by OutreachScheduler and HeartbeatWatchdogScheduler so both read the
 * same dashboard-editable schedule settings the same way.
 */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeStr(v: unknown): v is string {
  return typeof v === 'string' && TIME_RE.test(v);
}

export function isValidHour(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 23;
}

/** 'HH:MM' -> a cron expression that fires once daily at that minute/hour. */
export function dailyCronAt(hhmm: string): string {
  const [hour, minute] = hhmm.split(':').map(Number);
  return `${minute} ${hour} * * *`;
}

/**
 * A cron expression that fires every `everyMinutes` minutes, but only within
 * the [startHour, endHour] hour range (inclusive of both ends — e.g. 9-21
 * ticks from 09:00 through 21:55 at a 5-minute step).
 */
export function hourRangeCron(startHour: number, endHour: number, everyMinutes: number): string {
  return `*/${everyMinutes} ${startHour}-${endHour} * * *`;
}

/** 'HH:MM' -> minutes since midnight, for ordering comparisons. */
export function timeStrToMinutes(hhmm: string): number {
  const [hour, minute] = hhmm.split(':').map(Number);
  return hour * 60 + minute;
}
