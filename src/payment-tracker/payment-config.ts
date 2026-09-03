/**
 * Payment Tracker configuration, parsed and validated in one place.
 *
 * Every default here is the safe one: scanning off, so deploying this code to
 * production does nothing until an operator opts in. Invalid values throw at
 * startup rather than silently falling back — a mistyped scan time that quietly
 * became 10:00, or a cap that quietly became 15, would be a worse outcome than
 * a failed boot, because nobody would notice.
 */
import { isValidTimeStr } from '../utils/cron-time';

export interface PaymentTrackerConfig {
  scanEnabled: boolean;
  scanTime: string;
  dailyCap: number;
}

export function readPaymentTrackerConfig(env: NodeJS.ProcessEnv): PaymentTrackerConfig {
  const scanTime = env.PAYMENT_TRACKER_SCAN_TIME || '10:00';
  if (!isValidTimeStr(scanTime)) throw new Error('PAYMENT_TRACKER_SCAN_TIME must be HH:MM');

  const rawCap = env.PAYMENT_TRACKER_DAILY_CAP || '15';
  const dailyCap = Number(rawCap);
  if (!Number.isInteger(dailyCap) || dailyCap <= 0) {
    throw new Error('PAYMENT_TRACKER_DAILY_CAP must be a positive integer');
  }

  // Exactly 'true'. Anything else — including 'TRUE' or '1' — leaves scanning
  // off, so a half-remembered value cannot switch on a pipeline that sends
  // customers messages about money.
  return { scanEnabled: env.PAYMENT_TRACKER_SCAN_ENABLED === 'true', scanTime, dailyCap };
}
