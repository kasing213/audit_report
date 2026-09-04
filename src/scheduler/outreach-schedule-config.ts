export const DEFAULT_OUTREACH_DAILY_TIME = '13:00';

/** Return a canonical HH:mm value, or null when the input is not valid. */
export function normalizeDailyTime(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Convert a validated HH:mm value into a once-per-day five-field cron. */
export function dailyTimeToCron(value: string): string {
  const normalized = normalizeDailyTime(value);
  if (!normalized) throw new RangeError('daily_time must use HH:mm in 24-hour time');
  const [hour, minute] = normalized.split(':');
  return `${Number(minute)} ${Number(hour)} * * *`;
}

/** Convert a simple once-per-day cron into HH:mm for the dashboard time picker. */
export function cronToDailyTime(expression: string): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 || parts[2] !== '*' || parts[3] !== '*' || parts[4] !== '*') return null;
  if (!/^\d{1,2}$/.test(parts[0]) || !/^\d{1,2}$/.test(parts[1])) return null;
  return normalizeDailyTime(`${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')}`);
}
