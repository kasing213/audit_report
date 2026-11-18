import test from 'node:test';
import assert from 'node:assert/strict';
import type { DailySummaryDocument, LeadEventDocument } from '../../src/database/models';
import {
  buildFollowerDailyPages,
  closeSellInfo,
  groupByFollower,
  paginateGroup,
  followerPageCaption,
  reportCountRows
} from '../../src/reports/follower-daily';
import { dupeBadge, dupeEventId, dupeFlag, dupeOrdinals, nextOrdinal, phoneKeyRegexes, phoneKeys } from '../../src/reports/dupe-flags';
import { ExcelReportGenerator, uniqueSheetBase } from '../../src/reports/excel-report';
import { ReportDataService } from '../../src/reports/data-service';
import { getPreviousMonth } from '../../src/utils/time';

let seq = 0;
function ev(follower: string | null, model = 'bulk-telegram', extra: Partial<LeadEventDocument> = {}): LeadEventDocument {
  seq++;
  return {
    date: '2026-11-01',
    customer: { name: `C${seq}`, phone: `0${seq}` },
    page: 'Sun Tv',
    follower,
    status_text: null,
    source: { telegram_msg_id: `m${seq}`, model },
    created_at: new Date('2026-11-01T03:00:00Z'),
    ...extra
  };
}

// ── Grouping and filtering ──

test('entries are grouped per follower, trim/case folded, Unassigned last', () => {
  const groups = groupByFollower([
    ev('Bery'), ev(' bery '), ev('Seyi'), ev(null), ev('  '), ev('Bery')
  ]);
  assert.deepEqual(groups.map(g => [g.follower, g.followUps.length]), [
    ['Bery', 3], ['Seyi', 1], ['Unassigned', 2]
  ]);
});

test('close-sell records go to Closing sales, the rest to Follow-ups', () => {
  const [g] = groupByFollower([
    ev('Bery'), ev('Bery', 'closesell-telegram'), ev('Bery', 'closesell-telegram:potential'), ev('Bery', 'bulk-paste')
  ]);
  assert.equal(g.followUps.length, 2);
  assert.equal(g.closings.length, 2);
});

test('non-staff sources never reach the daily images', () => {
  const groups = groupByFollower([
    ev('Bery', 'csv-import'), ev('Bery', 'outreach-worker'), ev('Bery', 'meta-webhook'),
    ev('Bery', 'payment-tracker'), ev('Seyi', 'csv-import')
  ]);
  assert.deepEqual(groups, []);
});

test('a follower with only non-staff rows gets no image', () => {
  const pages = buildFollowerDailyPages([ev('Seyi', 'outreach-worker'), ev('Bery')]);
  assert.deepEqual(pages.map(p => p.follower), ['Bery']);
});

// ── Messages vs numbers given ──

function sum(follower: string | null, counters: Record<string, number>): DailySummaryDocument {
  return { date: '2026-11-01', follower, page: 'Sun Tv', counters, raw_text: '', source: { model: 'bulk-telegram' }, created_at: new Date() };
}

test('messages come from 1.Messege, message-only is messages minus numbers given', () => {
  const [p] = buildFollowerDailyPages(
    [ev('Bery'), ev('Bery'), ev('Bery', 'bulk-telegram', { customer: { name: 'x', phone: null } })],
    [sum('Bery', { messege: 8, phone: 2 }), sum('bery', { messege: 4 })]
  );
  assert.equal(p.totalMessages, 12);
  assert.equal(p.totalWithNumber, 2);
  assert.equal(p.totalMessageOnly, 10);
  assert.equal(followerPageCaption(p, '2026-11-01'), '📊 Bery — 2026-11-01\nMessages: 12 · Numbers: 2 · Message only: 10 · Closing: 0');
});

test('the same phone twice counts as one number', () => {
  const [p] = buildFollowerDailyPages([
    ev('Bery', 'bulk-telegram', { customer: { name: 'a', phone: '+85512' } }),
    ev('Bery', 'bulk-telegram', { customer: { name: 'a', phone: '+85512' } })
  ]);
  assert.equal(p.totalWithNumber, 1);
});

test('a follower who only sent counters still gets a report', () => {
  const pages = buildFollowerDailyPages([], [sum('Seyi', { messege: 5 }), sum('Sros', { fake: 1 })]);
  assert.deepEqual(pages.map(p => [p.follower, p.totalMessages, p.totalMessageOnly]), [['Seyi', 5, 5], ['Sros', null, null]]);
  assert.equal(pages[1].counters.fake, 1);
});

test('without a 1.Messege counter there is no message-only figure', () => {
  const [p] = buildFollowerDailyPages([ev('Bery')]);
  assert.equal(p.totalMessages, null);
  assert.equal(p.totalMessageOnly, null);
  // Still printed, as 0: the boss reads a missing figure as "not reported".
  assert.equal(followerPageCaption(p, '2026-11-01'), '📊 Bery — 2026-11-01\nMessages: 0 · Numbers: 1 · Message only: 0 · Closing: 0');
});

test('closing is in the caption with its count', () => {
  const [p] = buildFollowerDailyPages([ev('Bery'), ev('Bery', 'closesell-telegram')]);
  assert.match(followerPageCaption(p, '2026-11-01'), /Numbers: 1 · Message only: 0 · Closing: 1$/);
});

// ── Report counts: every template line, 0 when not sent ──

test('report counts list every template line, summed over the day, 0 when missing', () => {
  const [p] = buildFollowerDailyPages(
    [ev('Bery', 'bulk-telegram', { promise_date: '2026-11-03' }), ev('Bery')],
    [sum('Bery', { messege: 3, all_pages: 2, telegram: 1, message_connected_by_telegram: 2 }), sum('Bery', { all_pages: 1, messenger: 4 })]
  );
  const rows = reportCountRows(p.counters, p.totalDatingVisits);
  const a = Object.fromEntries(rows.sectionA.map(r => [r.label.trim(), r.value]));
  assert.equal(a['1. Messege'], 3);
  assert.equal(a['2. ភ្ញៀវចូលគ្រប់ផេក'], 3);
  assert.equal(a['3. Fake (ក្លែងក្លាយ)'], 0);
  assert.equal(a['10. Dating visit (សន្យាមកមើល)'], 1);
  assert.equal(rows.sectionA.length, 12);
  const b = Object.fromEntries(rows.channels.map(r => [r.label, r]));
  assert.equal(rows.channels.length, 6);
  assert.equal(b['e. Telegram'].total, 1);
  assert.deepEqual(b['a. Messenger'].by, [0, 2, 0, 0]); // message / telegram / phone / other
  assert.equal(b['a. Messenger'].total, 4);              // `messenger` and `message` are one row
  assert.equal(b['d. Group'].total, 0);
});

// ── Repeat numbers: 2nd time yellow, 3rd+ red ──

function at(iso: string, phone: string, extra: Partial<LeadEventDocument> = {}): LeadEventDocument {
  return ev('Bery', 'bulk-telegram', { _id: `id${++seq}`, customer: { name: null, phone }, created_at: new Date(iso), ...extra });
}

test('phone keys ignore +855, a leading 0, spaces and split a/b', () => {
  assert.deepEqual(phoneKeys('+855 12 345 678'), ['12345678']);
  assert.deepEqual(phoneKeys('012345678/0987654321'), ['12345678', '987654321']);
  assert.deepEqual(phoneKeys(''), []);
  assert.ok(phoneKeyRegexes(['12345678'])[0].test('012-345-678'));
  assert.ok(!phoneKeyRegexes(['12345678'])[0].test('0123456789'));
});

test('a number is flagged the 2nd (yellow) and 3rd+ (red) time it is reported', () => {
  const first = at('2026-11-01T01:00:00Z', '+85512345678');
  const second = at('2026-11-02T01:00:00Z', '012345678');
  const third = at('2026-11-03T01:00:00Z', '012 345 678/099999999');
  const other = at('2026-11-03T02:00:00Z', '+85599111222');
  const d = dupeOrdinals([second, third, other], [first, second, third, other]);
  assert.equal(d.get(dupeEventId(second)), 2);
  assert.equal(d.get(dupeEventId(third)), 3);
  assert.equal(d.get(dupeEventId(other)), 1);
  assert.deepEqual([1, 2, 3, 7].map(dupeFlag), [null, 'yellow', 'red', 'red']);
  assert.equal(dupeBadge(2), '🟡 2nd');
  assert.equal(dupeBadge(3), '🔴 3rd');
  assert.equal(dupeBadge(1), '');
});

test('the same paste, close-sells, imports and deleted rows are not repeats', () => {
  const tel = at('2026-11-02T01:00:00Z', '012345678', { report_hash: 'h1' });
  const dating = at('2026-11-02T01:00:00Z', '012345678', { report_hash: 'h1' });
  const closing = at('2026-11-01T01:00:00Z', '012345678', { source: { telegram_msg_id: 'c', model: 'closesell-telegram' } });
  const imported = at('2026-10-01T01:00:00Z', '012345678', { source: { telegram_msg_id: 'i', model: 'csv-import' } });
  const deleted = at('2026-10-02T01:00:00Z', '012345678', { deleted: true });
  const d = dupeOrdinals([tel, dating], [tel, dating, closing, imported, deleted]);
  assert.equal(d.get(dupeEventId(tel)), 1);
  assert.equal(d.get(dupeEventId(dating)), 1);
  assert.equal(nextOrdinal('012345678', [tel, dating, closing]), 2);
});

test('a later Dating-only entry is neither flagged nor counted', () => {
  const lead = at('2026-11-01T01:00:00Z', '012345678');
  const visit = at('2026-11-05T01:00:00Z', '012345678', { source: { telegram_msg_id: 'bulk-tg-1-dating-1', model: 'bulk-telegram' } });
  const again = at('2026-11-06T01:00:00Z', '012345678');
  const d = dupeOrdinals([visit, again], [lead, visit, again]);
  assert.equal(d.get(dupeEventId(visit)), undefined);
  assert.equal(d.get(dupeEventId(again)), 2);
});

// ── Close-sell closer and counts ──

test('closer and counts are read from the packed note of older records', () => {
  const info = closeSellInfo(ev('Bery', 'closesell-telegram', {
    note: 'កក់=2; មិនទាន់កក់=1; អ្នកបិទលក់៖ Theary; ទាក់ទងដំបូង=1-3day'
  }));
  assert.deepEqual(info, { closer: 'Theary', booked: 2, not_booked: 1 });
});

test('a not-booked-only note is not mistaken for booked', () => {
  const info = closeSellInfo(ev('Bery', 'closesell-telegram', { note: 'មិនទាន់កក់=3; ok' }));
  assert.deepEqual(info, { closer: null, booked: 0, not_booked: 3 });
});

test('structured fields win over the note', () => {
  const info = closeSellInfo(ev('Bery', 'closesell-telegram', {
    note: 'កក់=9', closer: 'Jim', booked: 1, not_booked: 0
  }));
  assert.deepEqual(info, { closer: 'Jim', booked: 1, not_booked: 0 });
});

// ── Pagination ──

test('long lists split into images of at most maxRows with page totals kept', () => {
  const rows = [
    ...Array.from({ length: 23 }, () => ev('Bery')),
    ...Array.from({ length: 4 }, () => ev('Bery', 'closesell-telegram', { note: 'កក់=1' }))
  ];
  const [g] = groupByFollower(rows);
  const pages = paginateGroup(g, 10);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map(p => [p.followUps.length, p.closings.length]), [[10, 0], [10, 0], [3, 4]]);
  assert.deepEqual(pages.map(p => [p.followUpStart, p.closingStart]), [[0, 0], [10, 0], [20, 0]]);
  for (const p of pages) {
    assert.equal(p.totalFollowUps, 23);
    assert.equal(p.totalClosings, 4);
    assert.equal(p.totalBooked, 4);
  }
  assert.match(followerPageCaption(pages[1], '2026-11-01'), /Bery — 2026-11-01 \(2\/3\)/);
});

test('a short list is one image without a part number', () => {
  const [p] = buildFollowerDailyPages([ev('Bery')]);
  assert.equal(p.pages, 1);
  assert.doesNotMatch(followerPageCaption(p, '2026-11-01'), /\(1\/1\)/);
});

// ── Monthly Excel ──

test('monthly Events sheet keeps its title in A1 and headers in row 4', () => {
  const { workbook, followers } = new ExcelReportGenerator().buildMonthlyWorkbook([], [ev('Bery'), ev('bery ')], 2026, 10);
  assert.deepEqual(followers, ['Bery']);
  const sheet = workbook.getWorksheet('Events - Bery')!;
  assert.equal(sheet.getCell('A1').value, 'Event History - Bery - October 2026');
  assert.equal(sheet.getCell('A4').value, 'Date');
  assert.equal(sheet.getCell('L4').value, 'Model');
  assert.equal(sheet.getCell('A5').value, '2026-11-01');
  assert.equal(sheet.getCell('A6').value, '2026-11-01');
});

test('long follower names sharing 22 chars get distinct sheets', () => {
  const a = 'Sales-management-group-A';
  const b = 'Sales-management-group-B';
  const { workbook } = new ExcelReportGenerator().buildMonthlyWorkbook([], [ev(a), ev(b), ev(null)], 2026, 10);
  const names = workbook.worksheets.map(w => w.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every(n => n.length <= 31));
  assert.equal(names.length, 6);
});

test('sheet names drop characters Excel forbids', () => {
  assert.equal(uniqueSheetBase('A/B:C', new Set()), 'A-B-C');
});

// ── Month calculation ──

test('previous month uses Cambodia time, not UTC', () => {
  // 00:01 on 1 Nov in Phnom Penh is still 31 Oct in UTC.
  const now = new Date('2026-10-31T17:01:00Z');
  assert.deepEqual(getPreviousMonth('Asia/Phnom_Penh', now), { year: 2026, month: 10 });
  assert.deepEqual(getPreviousMonth('Asia/Phnom_Penh', new Date('2026-01-01T00:00:00+07:00')), { year: 2025, month: 12 });
});

test('monthly Events sheet shows the time in Phnom Penh, not server UTC', () => {
  const { workbook } = new ExcelReportGenerator().buildMonthlyWorkbook(
    [], [ev('Bery', 'bulk-telegram', { created_at: new Date('2026-11-01T02:30:00Z') })], 2026, 11);
  assert.match(String(workbook.getWorksheet('Events - Bery')!.getCell('B5').value), /^09:30/);
});

test('monthly events leave out deleted customers and other orgs', async () => {
  let query: any;
  const service: any = Object.create(ReportDataService.prototype);
  service.repository = { db: { getDb: () => ({ collection: () => ({
    find: (q: any) => { query = q; return { toArray: async () => [] }; },
  }) }) } };
  await service.getMonthlyLeadEvents(2026, 10);
  assert.deepEqual(query.deleted, { $ne: true });
  assert.deepEqual(query.org_id, { $in: [null, 'company'] });
});
