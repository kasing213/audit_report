import type { LeadEventDocument } from '../database/models';

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

/** Staff entries split per follower (sorted by name, Unassigned last). */
export function groupByFollower(events: LeadEventDocument[]): FollowerDailyGroup[] {
  const groups = new Map<string, FollowerDailyGroup>();
  for (const e of events) {
    if (!isStaffSalesEntry(e)) continue;
    const key = followerKey(e.follower);
    let g = groups.get(key);
    if (!g) {
      g = { follower: cleanFollower(e.follower) || UNASSIGNED, followUps: [], closings: [] };
      groups.set(key, g);
    }
    (isCloseSell(e) ? g.closings : g.followUps).push(e);
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
  const totals = {
    totalFollowUps: g.followUps.length,
    totalClosings: g.closings.length,
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

export function buildFollowerDailyPages(events: LeadEventDocument[], maxRows = MAX_ROWS_PER_IMAGE): FollowerDailyPage[] {
  return groupByFollower(events).flatMap(g => paginateGroup(g, maxRows));
}

export function followerPageCaption(p: FollowerDailyPage, date: string): string {
  const part = p.pages > 1 ? ` (${p.page}/${p.pages})` : '';
  return `📊 ${p.follower} — ${date}${part}\nFollow-ups: ${p.totalFollowUps} · Closing sales: ${p.totalClosings}`;
}

export function followerPageFilename(p: FollowerDailyPage, date: string): string {
  const safe = p.follower.replace(/[^\p{L}\p{M}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'follower';
  return `daily-${date}-${safe}${p.pages > 1 ? `-${p.page}of${p.pages}` : ''}.jpg`;
}
