import type { LeadEventDocument } from '../database/models';
import { isCloseSell, isStaffSalesEntry } from './follower-daily';

/**
 * Repeat phone numbers in staff follow-ups. The 2nd time a number is
 * reported it is flagged yellow, the 3rd time and after red. Close-sells are
 * left out: a lead that is followed up and then closed is the normal path.
 */

/** Phone → comparable keys: digits only, without 855 / leading 0; one per `a/b` part. */
export function phoneKeys(phone: string | null | undefined): string[] {
  return (phone || '')
    .split('/')
    .map(p => p.replace(/\D/g, '').replace(/^855/, '').replace(/^0+/, ''))
    .filter(k => k.length >= 7);
}

/** Mongo regexes that find a stored phone with the same keys, whatever its format. */
export function phoneKeyRegexes(keys: string[]): RegExp[] {
  return keys.map(k => new RegExp(`(^|[^\\d])(\\+?855|0)?[\\s.-]*${k.split('').join('[\\s.-]*')}([^\\d]|$)`));
}

function counts(e: LeadEventDocument): boolean {
  return !e.deleted && isStaffSalesEntry(e) && !isCloseSell(e);
}

// One paste can hold the same number twice (a Tel slot and its Dating line):
// that is one report, not a repeat.
function reportKey(e: LeadEventDocument): string {
  return e.report_hash || String(e._id ?? e.source?.telegram_msg_id);
}

function eventId(e: LeadEventDocument): string {
  return String(e._id ?? e.source?.telegram_msg_id);
}

/**
 * For each of the day's follow-ups: how many times its number has been
 * reported, this one included (1 = first time). `history` holds every event
 * that shares a number with them, the day's own included.
 */
export function dupeOrdinals(dayEvents: LeadEventDocument[], history: LeadEventDocument[]): Map<string, number> {
  const out = new Map<string, number>();
  const prior = history.filter(counts);
  for (const e of dayEvents) {
    if (!counts(e)) continue;
    const keys = new Set(phoneKeys(e.customer?.phone));
    if (keys.size === 0) continue;
    const at = new Date(e.created_at).getTime();
    const mine = reportKey(e);
    const earlier = new Set<string>();
    for (const h of prior) {
      const rk = reportKey(h);
      if (rk === mine || new Date(h.created_at).getTime() > at) continue;
      if (new Date(h.created_at).getTime() === at && eventId(h) >= eventId(e)) continue;
      if (phoneKeys(h.customer?.phone).some(k => keys.has(k))) earlier.add(rk);
    }
    out.set(eventId(e), earlier.size + 1);
  }
  return out;
}

/** Before saving: the time this number would be reported, given what is already stored. */
export function nextOrdinal(phone: string | null | undefined, stored: LeadEventDocument[]): number {
  const keys = new Set(phoneKeys(phone));
  if (keys.size === 0) return 1;
  const reports = new Set(
    stored.filter(counts).filter(h => phoneKeys(h.customer?.phone).some(k => keys.has(k))).map(reportKey)
  );
  return reports.size + 1;
}

export function dupeFlag(ordinal: number | undefined): 'yellow' | 'red' | null {
  if (!ordinal || ordinal < 2) return null;
  return ordinal === 2 ? 'yellow' : 'red';
}

export function ordinalLabel(n: number): string {
  return n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}

/** `🟡 2nd` / `🔴 3rd` for chat text; '' the first time. */
export function dupeBadge(ordinal: number | undefined): string {
  const flag = dupeFlag(ordinal);
  return flag ? `${flag === 'yellow' ? '🟡' : '🔴'} ${ordinalLabel(ordinal!)}` : '';
}

export { eventId as dupeEventId };
