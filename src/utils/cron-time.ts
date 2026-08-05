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

/**
 * Current minutes-since-midnight in the given IANA timezone. Uses
 * formatToParts with hourCycle 'h23' rather than a locale-formatted string —
 * some ICU locales render midnight as "24:00" under hour12:false, which
 * would corrupt a naive HH:MM parse.
 */
export function currentMinutesInTz(tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/**
 * Whether `nowMinutes` falls within [startHour, endHour] inclusive of the
 * whole endHour (e.g. startHour=9, endHour=21 covers 09:00 through 21:59) —
 * matches the hour-range semantics of the cron built by hourRangeCron.
 */
export function isWithinHourRange(nowMinutes: number, startHour: number, endHour: number): boolean {
  return nowMinutes >= startHour * 60 && nowMinutes < (endHour + 1) * 60;
}
