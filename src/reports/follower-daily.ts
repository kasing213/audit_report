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
  counters: Record<string, number>; // every bulk-report counter, summed over the day's reports
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
  counters: Record<string, number>;
  totalDatingVisits: number;       // follow-ups with a promised visit date
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
      g = { follower: cleanFollower(follower) || UNASSIGNED, followUps: [], closings: [], messages: null, counters: {} };
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
    const counters = s.counters || {};
    if (Object.keys(counters).length === 0) continue;
    const g = groupFor(s.follower);
    for (const [k, v] of Object.entries(counters)) {
      if (typeof v === 'number') g.counters[k] = (g.counters[k] ?? 0) + v;
    }
    if (typeof counters.messege === 'number') g.messages = (g.messages ?? 0) + counters.messege;
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
    totalNotBooked: infos.reduce((s, i) => s + i.not_booked, 0),
    counters: g.counters,
    totalDatingVisits: g.followUps.filter(e => e.promise_date).length
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
  // Every figure is shown, 0 included: the boss reads a missing one as "not reported".
  const counts = [
    `Messages: ${p.totalMessages ?? 0}`,
    `Numbers: ${p.totalWithNumber}`,
    `Message only: ${p.totalMessageOnly ?? 0}`,
    `Closing: ${p.totalClosings}`
  ];
  return `📊 ${p.follower} — ${date}${part}\n${counts.join(' · ')}`;
}

export function followerPageFilename(p: FollowerDailyPage, date: string): string {
  const safe = p.follower.replace(/[^\p{L}\p{M}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'follower';
  return `daily-${date}-${safe}${p.pages > 1 ? `-${p.page}of${p.pages}` : ''}.jpg`;
}

// ── Report counts: every line of the bulk template, 0 when not sent ──

/** Section A of the bulk template, in its own order and wording. */
export const SECTION_A_ROWS: Array<[key: string, label: string]> = [
  ['messege', '1. Messege'],
  ['night', '   a. Night (ទទួលពេលយប់)'],
  ['pv', '   b. PV (ភ្ញៀវខេត្ត)'],
  ['all_pages', '2. ភ្ញៀវចូលគ្រប់ផេក'],
  ['fake', '3. Fake (ក្លែងក្លាយ)'],
  ['messenger_before', '4. ភ្ញៀវធ្លាប់ទាក់ទងក្នុង Messenger'],
  ['old_customer', '5. ភ្ញៀវចាស់ធ្លាប់មើលគំរោងរួច'],
  ['liked', '6. Liked (ចុចមេដៃ)'],
  ['follow_other', '7. Other (ផ្សេងៗ)'],
  ['follow_comment', 'Comment'],
  ['phone', '9. Phone (ចំនួនលេខទូរស័ព្ទ)']
];

/**
 * Section B "Connected by": where the customer came from (rows) and how they
 * then reached the sales person (columns). Telegram = a Messenger-boost lead
 * who texted the sales person on Telegram. Key aliases cover the /help
 * template (`a.Messenger`, `c.Call in`) and the team's full format
 * (`a.message...`, `c. Callin`).
 */
export const CHANNEL_ROWS: Array<[label: string, keys: string[]]> = [
  ['a. Messenger', ['messenger', 'message']],
  ['b. Comment', ['comment']],
  ['c. Call in', ['call_in', 'callin']],
  ['d. Group', ['group']],
  ['e. Telegram', ['telegram']],
  ['f. Other', ['other']]
];
export const CONNECTED_BY = ['message', 'telegram', 'phone', 'other'] as const;

export function channelTotal(counters: Record<string, number>, keys: string[], suffix = ''): number {
  return keys.reduce((sum, k) => sum + (counters[k + suffix] ?? 0), 0);
}

export function reportCountRows(counters: Record<string, number>, datingVisits: number) {
  return {
    sectionA: [
      ...SECTION_A_ROWS.map(([key, label]) => ({ label, value: counters[key] ?? 0 })),
      { label: '10. Dating visit (សន្យាមកមើល)', value: datingVisits }
    ],
    channels: CHANNEL_ROWS.map(([label, keys]) => ({
      label,
      total: channelTotal(counters, keys),
      by: CONNECTED_BY.map(c => channelTotal(counters, keys, `_connected_by_${c}`))
    }))
  };
}
