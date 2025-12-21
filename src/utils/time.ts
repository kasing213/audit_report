import { Logger } from './logger';

export function getTodayDate(timezoneEnv?: string): string {
  const timeZone = timezoneEnv || process.env.TIMEZONE || 'UTC';

  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  } catch (error) {
    Logger.warn(`Invalid TIMEZONE "${timeZone}", falling back to UTC.`);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
  }
}

export function getDateNDaysAgo(daysAgo: number, timezoneEnv?: string): string {
  const timeZone = timezoneEnv || process.env.TIMEZONE || 'UTC';
  const ms = Date.now() - Math.max(0, daysAgo) * 24 * 60 * 60 * 1000;
  const date = new Date(ms);

  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
  } catch (error) {
    Logger.warn(`Invalid TIMEZONE "${timeZone}", falling back to UTC.`);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(date);
  }
}

export function toZonedDateTime(dateStr: string, timeStr: string = '00:00', timezoneEnv?: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return null;
  }

  const [hoursStr, minutesStr] = (timeStr || '00:00').split(':');
  const hours = Number(hoursStr);
  const minutes = Number(minutesStr);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  const timeZone = timezoneEnv || process.env.TIMEZONE || 'UTC';
  const [year, month, day] = dateStr.split('-').map(Number);
  const baseUtc = Date.UTC(year, month - 1, day, hours, minutes, 0);
  const baseDate = new Date(baseUtc);

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(baseDate);

    const getPart = (type: string): number => Number(parts.find(p => p.type === type)?.value);

    const y = getPart('year');
    const m = getPart('month');
    const d = getPart('day');
    const h = getPart('hour');
    const min = getPart('minute');
    const s = getPart('second');

    const asUtc = Date.UTC(y, m - 1, d, h, min, s);
    const offsetMinutes = (asUtc - baseDate.getTime()) / 60000;
    return new Date(baseDate.getTime() - offsetMinutes * 60000);
  } catch (error) {
    Logger.warn(`Invalid TIMEZONE "${timeZone}", falling back to UTC.`);
    return baseDate;
  }
}
