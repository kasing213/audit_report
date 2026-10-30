import { Logger } from '../utils/logger';
import type { StaffMember } from '../staff/staff-resolver';

const REQUEST_TIMEOUT_MS = 5000;

/**
 * Staff roster from Payment-Tracker (GET /api/staff, X-API-Key auth).
 * Returns null when the API isn't configured, so callers can skip staff checks.
 * Throws on a failed request; StaffDirectory keeps its last good copy.
 */
export async function fetchStaffFromPaymentTracker(): Promise<StaffMember[] | null> {
  const baseUrl = process.env.PAYMENT_TRACKER_API_URL;
  const apiKey = process.env.PAYMENT_TRACKER_API_KEY;
  if (!baseUrl || !apiKey) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/staff`, {
      headers: { 'X-API-Key': apiKey },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Payment-Tracker /api/staff returned ${response.status}`);
    }
    const body = (await response.json()) as { staff?: StaffMember[] };
    return Array.isArray(body.staff) ? body.staff : [];
  } catch (error) {
    Logger.warn(`Payment-Tracker staff fetch failed: ${(error as Error).message}`);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
