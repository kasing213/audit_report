import type { DailySummaryDocument, LeadEventDocument } from '../database/models';

// Sources that are not a staff member's own sales entry: spreadsheet imports,
// outreach sends, Meta lead ads and Payment Tracker proposals. They stay in the
// DB and the monthly Excel, but never in the per-follower daily images.
export const NON_STAFF_SOURCES = ['csv-import', 'outreach-worker', 'meta-webhook', 'payment-tracker'];

export const MAX_ROWS_PER_IMAGE = 20;
export const UNASSIGNED = 'Unassigned';

export interface CloseSellInfo {
  closer: string | null;
  booked: number;
  not_booked: number;
}

export interface FollowerDailyGroup {
  follower: string;
  followUps: LeadEventDocument[];
  closings: LeadEventDocument[];
  messages: number | null; // sum of `1.Messege=` from the follower's bulk reports; null when none sent it
}

export interface FollowerDailyPage {
  follower: string;
  page: number;          // 1-based
  pages: number;
  followUps: LeadEventDocument[];
  closings: LeadEventDocument[];
  followUpStart: number; // rows before this page, for continuous numbering
  closingStart: number;
  totalFollowUps: number;
  totalClosings: number;
  totalMessages: number | null;
  totalWithNumber: number;         // distinct phone numbers among the follow-ups
  totalMessageOnly: number | null; // messages that gave no number
  totalBooked: number;
  totalNotBooked: number;
}

export function isStaffSalesEntry(e: LeadEventDocument): boolean {
  return !NON_STAFF_SOURCES.includes(e.source?.model);
}

export function isCloseSell(e: LeadEventDocument): boolean {
  return (e.source?.model || '').startsWith('closesell-telegram');
}

/** Trim + collapse spaces. Case is folded only for the grouping key. */
export function cleanFollower(name: string | null | undefined): string {
  return (name || '').replace(/\s+/g, ' ').trim();
}

export function followerKey(name: string | null | undefined): string {
  return cleanFollower(name).toLowerCase();
}

/**
 * Closer and booked/not-booked counts of a close-sell record. Records saved
 * after this change carry them as fields; older ones only have them in the
 * note packed by close-sell-parser (`កក់=N; មិនទាន់កក់=N; អ្នកបិទលក់៖ X; ...`).
 */
export function closeSellInfo(e: LeadEventDocument): CloseSellInfo {
  const note = e.note || '';
  const booked = note.match(/(?:^|; )កក់=(\d+)/);
  const notBooked = note.match(/(?:^|; )មិនទាន់កក់=(\d+)/);
  const closer = note.match(/(?:^|; )អ្នកបិទលក់៖ ([^;]+)/);
  return {
    closer: e.closer ?? (closer ? closer[1].trim() : null),
    booked: e.booked ?? (booked ? Number(booked[1]) : 0),
    not_booked: e.not_booked ?? (notBooked ? Number(notBooked[1]) : 0)
  };
}

/**
 * Staff entries and bulk-report counters split per follower (sorted by name,
 * Unassigned last). A follower who only sent counters still gets a group.
 */
export function groupByFollower(events: LeadEventDocument[], summaries: DailySummaryDocument[] = []): FollowerDailyGroup[] {
  const groups = new Map<string, FollowerDailyGroup>();
  const groupFor = (follower: string | null | undefined): FollowerDailyGroup => {
    const key = followerKey(follower);
    let g = groups.get(key);
    if (!g) {
      g = { follower: cleanFollower(follower) || UNASSIGNED, followUps: [], closings: [], messages: null };
      groups.set(key, g);
    }
    return g;
  };
  for (const e of events) {
    if (!isStaffSalesEntry(e)) continue;
    const g = groupFor(e.follower);
    (isCloseSell(e) ? g.closings : g.followUps).push(e);
  }
  for (const s of summaries) {
    const n = s.counters?.messege;
    if (typeof n !== 'number') continue;
    const g = groupFor(s.follower);
    g.messages = (g.messages ?? 0) + n;
  }
  const unassigned = groups.get('');
  groups.delete('');
  const sorted = Array.from(groups.values()).sort((a, b) => a.follower.localeCompare(b.follower));
  return unassigned ? [...sorted, unassigned] : sorted;
}

/** One group → one or more images of at most `maxRows` table rows each. */
export function paginateGroup(g: FollowerDailyGroup, maxRows = MAX_ROWS_PER_IMAGE): FollowerDailyPage[] {
  const rows = [
    ...g.followUps.map(e => ({ e, closing: false })),
    ...g.closings.map(e => ({ e, closing: true }))
  ];
  const pages = Math.max(1, Math.ceil(rows.length / maxRows));
  const infos = g.closings.map(closeSellInfo);
  const withNumber = new Set(g.followUps.map(e => e.customer?.phone).filter(Boolean)).size;
  const totals = {
    totalFollowUps: g.followUps.length,
    totalClosings: g.closings.length,
    totalMessages: g.messages,
    totalWithNumber: withNumber,
    totalMessageOnly: g.messages === null ? null : Math.max(0, g.messages - withNumber),
    totalBooked: infos.reduce((s, i) => s + i.booked, 0),
    totalNotBooked: infos.reduce((s, i) => s + i.not_booked, 0)
  };
  const out: FollowerDailyPage[] = [];
  for (let p = 0; p < pages; p++) {
    const slice = rows.slice(p * maxRows, (p + 1) * maxRows);
    out.push({
      follower: g.follower,
      page: p + 1,
      pages,
      followUps: slice.filter(r => !r.closing).map(r => r.e),
      closings: slice.filter(r => r.closing).map(r => r.e),
      followUpStart: Math.min(p * maxRows, g.followUps.length),
      closingStart: Math.max(0, p * maxRows - g.followUps.length),
      ...totals
    });
  }
  return out;
}

export function buildFollowerDailyPages(
  events: LeadEventDocument[],
  summaries: DailySummaryDocument[] = [],
  maxRows = MAX_ROWS_PER_IMAGE
): FollowerDailyPage[] {
  return groupByFollower(events, summaries).flatMap(g => paginateGroup(g, maxRows));
}

export function followerPageCaption(p: FollowerDailyPage, date: string): string {
  const part = p.pages > 1 ? ` (${p.page}/${p.pages})` : '';
  const counts = [
    ...(p.totalMessages !== null ? [`Messages: ${p.totalMessages}`] : []),
    `Numbers: ${p.totalWithNumber}`,
    ...(p.totalMessageOnly !== null ? [`Message only: ${p.totalMessageOnly}`] : []),
    ...(p.totalClosings > 0 ? [`Closing: ${p.totalClosings}`] : [])
  ];
  return `📊 ${p.follower} — ${date}${part}\n${counts.join(' · ')}`;
}

export function followerPageFilename(p: FollowerDailyPage, date: string): string {
  const safe = p.follower.replace(/[^\p{L}\p{M}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'follower';
  return `daily-${date}-${safe}${p.pages > 1 ? `-${p.page}of${p.pages}` : ''}.jpg`;
}
