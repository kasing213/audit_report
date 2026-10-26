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
  assert.equal(drafts[0].follower, 'Jim');
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
