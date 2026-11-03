import test from 'node:test';
import assert from 'node:assert/strict';
import type { DailySummaryDocument, LeadEventDocument } from '../../src/database/models';
import {
  buildFollowerDailyPages,
  closeSellInfo,
  groupByFollower,
  paginateGroup,
  followerPageCaption
} from '../../src/reports/follower-daily';
import { ExcelReportGenerator, uniqueSheetBase } from '../../src/reports/excel-report';
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
  assert.equal(followerPageCaption(p, '2026-11-01'), '📊 Bery — 2026-11-01\nMessages: 12 · Numbers: 2 · Message only: 10');
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
  assert.deepEqual(pages.map(p => [p.follower, p.totalMessages, p.totalMessageOnly]), [['Seyi', 5, 5]]);
});

test('without a 1.Messege counter there is no message-only figure', () => {
  const [p] = buildFollowerDailyPages([ev('Bery')]);
  assert.equal(p.totalMessages, null);
  assert.equal(p.totalMessageOnly, null);
  assert.equal(followerPageCaption(p, '2026-11-01'), '📊 Bery — 2026-11-01\nNumbers: 1');
});

test('closing shows in the caption only on a day that has one', () => {
  const [p] = buildFollowerDailyPages([ev('Bery'), ev('Bery', 'closesell-telegram')]);
  assert.match(followerPageCaption(p, '2026-11-01'), /Numbers: 1 · Closing: 1$/);
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
