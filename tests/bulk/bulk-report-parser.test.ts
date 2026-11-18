import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBulkReport } from '../../src/parser/bulk-report-parser';
import { BulkEntryFlow } from '../../src/bot/flows/bulk-entry-flow';
import { FULL_FORMAT_REPORT } from './full-format-fixture';

const leads = (text: string) => parseBulkReport(text).drafts;

// ── The team's full format (phones first, a-j reasons in a second list) ──

test('full format: the customer in the first list becomes a lead', () => {
  const drafts = leads(FULL_FORMAT_REPORT);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].customer_phone, '+855889475139');
  assert.equal(drafts[0].customer_name, 'long ya');
  assert.equal(drafts[0].follower, null);  // "Jim" is a copied name line, never a follower
  assert.equal(drafts[0].date, '2026-10-25');
});

test('full format: the reason comes from the second list, matched by phone', () => {
  const [lead] = leads(FULL_FORMAT_REPORT);
  assert.equal(lead.reason_code, 'A');
});

test('full format: a second marked reason is kept in the note, not dropped', () => {
  const [lead] = leads(FULL_FORMAT_REPORT);
  assert.match(lead.note ?? '', /\bI\b/);
  assert.match(lead.note ?? '', /ចាំរកថ្ងៃទំនេរមកមើល/);
});

test('full format: a numbered Tel1 gets its reason too (not swallowed by Tel10)', () => {
  const text = FULL_FORMAT_REPORT.replace('T el 0889475139', 'Tel1= 0889475139');
  const [lead] = leads(text);
  assert.equal(lead.customer_phone, '+855889475139');
  assert.equal(lead.reason_code, 'A');
});

test('full format: reasons follow the phone even when the second list is reordered', () => {
  const text = [
    '#របាយការណ៍ថ្ងៃទី25/10/26',
    'Jim',
    'Tel1=012345678',
    '   Name=Dara',
    'Tel2=098765432',
    '   Name=Mony',
    '👉 g.ភ្ញៀវឆ្លើយតបដូចខាងក្រោម',
    'Tel1=098765432',
    '   b.ទីតាំងមិនត្រូវ=1',
    'Tel2=012345678',
    '   e.ត្រូវការកម្ចីច្រើន=1',
  ].join('\n');
  const byName = Object.fromEntries(leads(text).map(d => [d.customer_name, d.reason_code]));
  assert.deepEqual(byName, { Dara: 'E', Mony: 'B' });
});

test('full format: an unnumbered or phoneless Tel in the second list maps by its position', () => {
  const text = [
    '#របាយការណ៍ថ្ងៃទី25/10/26',
    'Tel1=012345678',
    'Tel2=098765432',
    '👉 g.ភ្ញៀវឆ្លើយតបដូចខាងក្រោម',
    'Tel=',
    '   d គ្មានចំណាប់អារម្មណ៍=1',
    'T2=,0',
    '   h.ដីរឺផ្ទះតូចពេក=1',
  ].join('\n');
  assert.deepEqual(leads(text).map(d => d.reason_code), ['D', 'H']);
});

test('full format: "Connected by" counts land under their channel', () => {
  const text = FULL_FORMAT_REPORT
    .replace('a.messageវ៉ៃលេខ\n   1/Connected by message=', 'a.messageវ៉ៃលេខ\n   1/Connected by message=2')
    .replace('c. Callin 0\n   1/Connected by message=\n   2/Connected by telegram=\n   3/Connected by Phone=',
      'c. Callin 0\n   1/Connected by message=\n   2/Connected by telegram=\n   3/Connected by Phone=1');
  const { counters } = parseBulkReport(text).summary;
  assert.equal(counters.message_connected_by_message, 2);
  assert.equal(counters.callin_connected_by_phone, 1);
  assert.equal(counters.messege, 8);
  assert.equal(counters.night, 3);
});

test('full format: the bot recognises it as a bulk report', () => {
  assert.equal(BulkEntryFlow.detectsBulkReport(FULL_FORMAT_REPORT), true);
});

// ── The bot's own short template keeps working ──

const SHORT_TEMPLATE = [
  '💞Follow up',
  '#របាយការណ៍ថ្ងៃទី19/9/26',
  'Jim',
  '🚩Page Test',
  '',
  'A.Follow (Boots Page)',
  '   1.Messege=4',
  '',
  'B.ប្រភពទំនាក់ទំនង (Connected by)',
  '   a.Messenger=5',
  '   b.Comment=0',
  '',
  'Tel1=012345678',
  '   Name=Sok Dara',
  '   Pv=PP',
  '   a.ថ្លៃពេក=',
  '   g.ខូចCBC=1',
  '',
  'Tel2=',
  '   Name=',
  '   Pv=',
].join('\n');

test('short template: inline reasons still read per Tel', () => {
  const drafts = leads(SHORT_TEMPLATE);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].customer_name, 'Sok Dara');
  assert.equal(drafts[0].reason_code, 'G');
  assert.equal(drafts[0].note, 'Province: PP');
});

test('short template: channel totals stay counters', () => {
  const { counters } = parseBulkReport(SHORT_TEMPLATE).summary;
  assert.equal(counters.messenger, 5);
  assert.equal(counters.messege, 4);
});

test('a reason written with a space instead of "=" still counts', () => {
  const text = [
    '#របាយការណ៍ថ្ងៃទី19/9/26',
    'Tel1=012345678',
    '   I.ចាំរកថ្ងៃទំនេរមកមើល 1',
  ].join('\n');
  assert.equal(leads(text)[0].reason_code, 'I');
});

test('a report without a Dating section keeps its last line', () => {
  const text = ['#របាយការណ៍ថ្ងៃទី19/9/26', 'Tel1=012345678', '   b.ទីតាំងមិនត្រូវ=1'].join('\n');
  assert.equal(leads(text)[0].reason_code, 'B');
});

// ── The same report with its line breaks gone (how it really arrives) ──

import { FLAT_FORMAT_REPORT } from './flat-format-fixture';

test('flat paste: the bot recognises it as a bulk report', () => {
  assert.equal(BulkEntryFlow.detectsBulkReport(FLAT_FORMAT_REPORT), true);
});

test('flat paste: same lead as the line-broken report', () => {
  const drafts = leads(FLAT_FORMAT_REPORT);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].customer_phone, '+855889475139');
  assert.equal(drafts[0].customer_name, 'long ya');
  assert.equal(drafts[0].reason_code, 'A');
  assert.match(drafts[0].note ?? '', /Also: I/);
});

test('flat paste: header and counters', () => {
  const r = parseBulkReport(FLAT_FORMAT_REPORT);
  assert.deepEqual(r.header, { date: '2026-10-25', follower: null, page: 'Page Sun Tv (Biry)', owner_name: 'Biry' });
  assert.equal(r.summary.counters.messege, 8);
  assert.equal(r.summary.counters.night, 3);
  assert.equal(r.summary.counters.callin, 0);
});

test('flat paste: the saved raw text is the message as sent', () => {
  assert.equal(parseBulkReport(FLAT_FORMAT_REPORT).summary.raw_text, FLAT_FORMAT_REPORT);
});

test('a name with a capital letter and a space is not split', () => {
  const text = ['#របាយការណ៍ថ្ងៃទី19/9/26', 'Tel1=012345678 Name=Chan A Mony Pv=PP'].join('\n');
  const [lead] = leads(text);
  assert.equal(lead.customer_name, 'Chan A Mony');
  assert.equal(lead.note, 'Province: PP');
});

test('a report pasted as one single line is still read', () => {
  const oneLine = FLAT_FORMAT_REPORT.replace(/\s*\n\s*/g, ' ');
  assert.equal(BulkEntryFlow.detectsBulkReport(oneLine), true);
  const drafts = leads(oneLine);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].customer_name, 'long ya');
  assert.equal(drafts[0].reason_code, 'A');
});

test('bulk: "Jim" or the group name on the name line is never a follower', () => {
  for (const line of ['Jim', 'Sales-management-group', 'YourName']) {
    const p = parseBulkReport(`#របាយការណ៍ថ្ងៃទី3/11/26\n${line}\n🚩Page sun tv\nA.Follow (Boots Page)\nTel1=012345678`);
    assert.equal(p.header.follower, null, line);
  }
  const biry = parseBulkReport('#របាយការណ៍ថ្ងៃទី3/11/26\nJim\n🚩Page sun tv(Biry)\nA.Follow (Boots Page)\nTel1=012345678');
  assert.equal(biry.header.follower, null);
  assert.equal(biry.header.owner_name, 'Biry');
});

// ── Every header line of the team's template is read (2026-11-16 audit) ──

const ALL_FIELDS_REPORT = [
  '_ស .💞Follow up', '#របាយការណ៍ថ្ងៃទី16/11/26', 'Sok', '🚩Page Sun Tv (Sok)',
  'A.Follow (Boots Page)',
  '    1.Messege=11',
  '       a.Night(ទទួលពេលយប=12',
  '       b.PV(ភ្ញៀវខេត្ត)=13',
  '          👉បរិយាយខេត្តណា=Kampot',
  '    2.ភ្ញៀវចូលគ្រប់ផេក=15',
  '    3..Fack(ក្លែងក្លាយ)=16',
  '    4.ភ្ញៀវធ្លាប់ទាក់ទងក្នុងMesseger=17',
  '    5.ភ្ញៀវចាស់ធ្លាប់មើលគំរោងរួច=18',
  '    6.Liked(ចុចមេដៃ)=19',
  '    7.Other(ផ្សេងៗ)=20',
  'comment =21',
  '☎️9.Phone (ចំនួនលេខទូរស័ព្ទ)= 01',
  'Tel1=012345678', '       Name=A', '       Pv=PP',
  'a.messageវ៉ៃលេខ 23', '   1/Connected by message=24', '   2/Connected by telegram=25', '   3/Connected by Phone=26', '   4/Connected by other=27',
  'b.Comment=5', '   1/Connected by message=28', '   2/Connected by telegram=29', '   3/Connected by Phone=30', '   4/Connected by other=31',
  'c. Callin 32', '   1/Connected by message=33', '   2/Connected by telegram=34', '   3/Connected by Phone=35', '   4/Connected by other=36',
  'd Group=', '   1/Connected by message=37', '   2/Connected by telegram=38', '   3/Connected by Phone=39', '   4/Connected by other=40',
  'e.Telegram=2', '   1/Connected by message=41', '   2/Connected by telegram=42', '   3/Connected by Phone=43', '   4/Connected by other=44',
  'f Other=6', '   1/Connected by message=45', '   2/Connected by telegram=46', '   3/Connected by Phone=47', '   4/Connected by other 48',
  '/🥰10 .Dating visit (សន្យាមកមើល)', '   1/លេខទូរស័ព្ =012345678', '       a ថ្ងៃ.ខែ.ឆ្នាំម៉ោង5:34pm20/11/26',
].join('\n');

test('all fields: Khmer-only, typo and emoji section-A lines are read', () => {
  const { counters } = parseBulkReport(ALL_FIELDS_REPORT).summary;
  assert.deepEqual(
    [counters.messege, counters.night, counters.pv, counters.all_pages, counters.fake, counters.messenger_before,
      counters.old_customer, counters.liked, counters.follow_other, counters.follow_comment, counters.phone],
    [11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 1]
  );
});

test('all fields: 7.Other and comment are not overwritten by Connected-by rows b and f', () => {
  const { counters } = parseBulkReport(ALL_FIELDS_REPORT).summary;
  assert.equal(counters.follow_other, 20);
  assert.equal(counters.other, 6);
  assert.equal(counters.follow_comment, 21);
  assert.equal(counters.comment, 5);
});

test('all fields: the whole Connected-by grid is read, Telegram row and column', () => {
  const { counters } = parseBulkReport(ALL_FIELDS_REPORT).summary;
  assert.equal(counters.telegram, 2);
  assert.equal(counters.telegram_connected_by_telegram, 42);
  assert.equal(counters.message_connected_by_telegram, 25);
  assert.equal(counters.callin, 32);
  assert.equal(counters.group_connected_by_other, 40);
  assert.equal(counters.other_connected_by_other, 48); // no "=" before the number
  const grid = Object.keys(counters).filter(k => k.includes('_connected_by_'));
  assert.equal(grid.length, 24);
});

test('all fields: a clean report has no warnings; the Dating line is still read', () => {
  const r = parseBulkReport(ALL_FIELDS_REPORT);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.drafts[0].promise_date, '2026-11-20');
});

test('a Connected-by line written with a dot is not a section-A item', () => {
  const { counters } = parseBulkReport(ALL_FIELDS_REPORT.replace('   1/Connected by message=24', '   1.Connected by message=24')).summary;
  assert.equal(counters.messege, 11);
  assert.equal(counters.message_connected_by_message, 24);
});

test('warning: a number on a line the parser cannot place', () => {
  const r = parseBulkReport(ALL_FIELDS_REPORT.replace('    7.Other(ផ្សេងៗ)=20', '    7.Other(ផ្សេងៗ)=20\n    ភ្ញៀវថ្មី=3'));
  assert.deepEqual(r.warnings, ['Line not read (number ignored): ភ្ញៀវថ្មី=3']);
});

test('warning: 9.Phone does not match the Tel numbers read', () => {
  const r = parseBulkReport(ALL_FIELDS_REPORT.replace('= 01', '= 3'));
  assert.deepEqual(r.warnings, ['9.Phone says 3 but 1 Tel number(s) were read']);
});

test('the real full-format and flat reports raise no warnings', () => {
  assert.deepEqual(parseBulkReport(FULL_FORMAT_REPORT).warnings, []);
  assert.deepEqual(parseBulkReport(FLAT_FORMAT_REPORT).warnings, []);
});

test('all fields: the same report pasted flat (line breaks lost) reads the same counters', () => {
  const full = parseBulkReport(ALL_FIELDS_REPORT).summary.counters;
  const flat = parseBulkReport(ALL_FIELDS_REPORT.replace(/\s*\n\s*/g, ' ')).summary.counters;
  assert.deepEqual(flat, full);
});
