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
