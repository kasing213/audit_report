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
