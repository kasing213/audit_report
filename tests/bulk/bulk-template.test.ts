import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBulkReport } from '../../src/parser/bulk-report-parser';
import { HelpCommand } from '../../src/bot/commands/help-command';
import { BulkEntryFlow } from '../../src/bot/flows/bulk-entry-flow';
import { COLLEAGUE_REPORT } from './colleague-fixture';
import { USER_NEW_TEMPLATE } from './new-template-fixture';

const template = (): string =>
  (new HelpCommand() as any).buildBulkCopyTemplate('26/10/26');

const slot = (tpl: string, n: number): string => {
  const start = tpl.indexOf(`Tel${n}=`);
  const next = tpl.indexOf(`Tel${n + 1}=`);
  return tpl.slice(start, next > 0 ? next : tpl.length);
};

test('template: every Tel1..Tel10 already carries its a-j reasons', () => {
  const tpl = template();
  for (let n = 1; n <= 10; n++) {
    const body = slot(tpl, n);
    for (const line of ['a.ថ្លៃពេក=', 'e.ត្រូវការកម្ចីច្រើន=', 'I.ចាំរកថ្ងៃទំនេរមកមើល=', 'j.ផ្សេងៗ=']) {
      assert.ok(body.includes(line), `Tel${n} is missing ${line}`);
    }
  }
});

test('template: fits in one Telegram message', () => {
  assert.ok(template().length <= 4096, `template is ${template().length} chars`);
});

test('template: pasted back untouched it creates no leads', () => {
  assert.deepEqual(parseBulkReport(template()).drafts, []);
});

test('template: staff fill a slot and a reason, nothing else to copy', () => {
  const filled = template()
    .replace('Tel5=', 'Tel5=012777687')
    .replace(/(Tel5=[\s\S]*?h\.ដីរឺផ្ទះតូចពេក=)/, '$11');
  const [lead] = parseBulkReport(filled).drafts;
  assert.equal(lead.slot, 'Tel5');
  assert.equal(lead.customer_phone, '+85512777687');
  assert.equal(lead.reason_code, 'H');
});

test("colleague's paste of the old template still reads its two real leads", () => {
  const real = parseBulkReport(COLLEAGUE_REPORT).drafts.filter(d => d.slot.startsWith('Tel'));
  assert.deepEqual(real.map(d => [d.slot, d.customer_name, d.reason_code]), [
    ['Tel1', 'Sok Dara', 'A'],
    ['Tel3', 'ka ka', 'A'],
  ]);
});

// Header lines of the Nov 2026 template, each filled with a distinct number.
const HEADER_FILL: Array<[string, string]> = [
  ['1.សរុបMessege=', 'messege'], ['2.ភ្ញៀវចូលគ្រប់ផេក=', 'all_pages'],
  ['3..Fack(ក្លែងក្លាយ)=', 'fake'], ['3.1.សរុបឈ្មោះ=', 'fake_names'],
  ['4.ភ្ញៀវធ្លាប់ទាក់ទងក្នុងMesseger=', 'messenger_before'],
  ['5.ភ្ញៀវចាស់ធ្លាប់មើលគំរោងរួច=', 'old_customer'],
  ['6.Liked(ចុចមេដៃ)=', 'liked'], ['7.Other(ផ្សេងៗ)=', 'follow_other'],
  ['1/Chat Message=', 'chat_message'], ['2/Chat Telegram=', 'chat_telegram'],
  ['3/Chat Phone=', 'chat_phone'], ['4/Chat Other=', 'chat_other'],
  ['aCall in=', 'call_in'], ['c.Group=', 'group'], ['d.Telegram=', 'telegram'],
  ['f Other=', 'other'], ['☎️ សរុបចំនួនទូរស័ព្ទនិងការតបភ្ញៀ=', 'phone'],
];

const filledTemplate = (): { text: string; expected: Record<string, number> } => {
  let text = template();
  const expected: Record<string, number> = {};
  HEADER_FILL.forEach(([line, key], i) => {
    assert.ok(text.includes(line), `template is missing ${line}`);
    text = text.replace(line, `${line}${i + 1}`);
    expected[key] = i + 1;
  });
  // Every slot gets a phone and a different reason: Tel1 → a, ..., Tel10 → j.
  const reasons = ['a.ថ្លៃពេក=', 'b.ទីតាំងមិនត្រូវ=', 'c ខ្ញុំមិនមែនអ្នកសំរេច=', 'd គ្មានចំណាប់អារម្មណ៍=',
    'e.ត្រូវការកម្ចីច្រើន=', 'f.ជំពាក់គេច្រើន=', 'g.ខូចCBC=', 'h.ដីរឺផ្ទះតូចពេក=', 'I.ចាំរកថ្ងៃទំនេរមកមើល=', 'j.ផ្សេងៗ='];
  const parts = text.split(/(?=👉Tel\d+=)/);
  for (let n = 1; n <= 10; n++) {
    parts[n] = parts[n]
      .replace(`👉Tel${n}=`, `👉Tel${n}=0127776${String(n).padStart(2, '0')}`)
      .replace(reasons[n - 1], reasons[n - 1] + (n === 10 ? 'ចង់បានដីធំ' : '1'));
  }
  return { text: parts.join(''), expected };
};

const ALL_SLOTS = 'ABCDEFGHIJ'.split('').map((code, i) => [
  `Tel${i + 1}`, `+855127776${String(i + 1).padStart(2, '0')}`, code, code === 'J' ? 'ចង់បានដីធំ' : null,
]);

test('template: every header counter reads under its own key', () => {
  const { text, expected } = filledTemplate();
  const p = parseBulkReport(text);
  assert.deepEqual(p.summary.counters, expected);
  assert.deepEqual(p.drafts.map(d => [d.slot, d.customer_phone, d.reason_code, d.note]), ALL_SLOTS);
});

test('template: a Messenger copy with its line breaks lost reads the same', () => {
  const { text, expected } = filledTemplate();
  const p = parseBulkReport(text.replace(/\n\s*/g, ' '));
  assert.deepEqual(p.summary.counters, expected);
  assert.deepEqual(p.drafts.map(d => [d.slot, d.customer_phone, d.reason_code, d.note]), ALL_SLOTS);
});

test("the user's 16/11/26 sample is detected and its Page owner read", () => {
  const sample = template()
    .replace(/ថ្ងៃទី \S+/, 'ថ្ងៃទី 16/11/26')
    .replace('ឈ្មោះផេករបស់អ្នក(ឈ្មោះរបស់អ្នក)', 'suntv(សុនី)')
    .replace('1.សរុបMessege=', '1.សរុបMessege=1')
    .replace('👉Tel1=', '👉Tel1=012345678').replace('a.ថ្លៃពេក=', 'a.ថ្លៃពេក=1');
  assert.ok(BulkEntryFlow.detectsBulkReport(sample));
  const p = parseBulkReport(sample);
  assert.deepEqual(p.header, { date: '2026-11-16', follower: null, page: 'Page suntv(សុនី)', owner_name: 'សុនី' });
  assert.deepEqual(p.drafts.map(d => [d.slot, d.customer_phone, d.reason_code]), [['Tel1', '+85512345678', 'A']]);
});

test("the user's literal 16/11/26 paste is detected; its two totals are counters, no leads", () => {
  assert.ok(BulkEntryFlow.detectsBulkReport(USER_NEW_TEMPLATE));
  const p = parseBulkReport(USER_NEW_TEMPLATE);
  assert.deepEqual(p.summary.counters, { messege: 1, phone: 0 });
  assert.deepEqual(p.drafts, []);
  assert.equal(p.header.owner_name, 'សុនី');
});

test('template: a zero-width space inside a Khmer label still reads the total', () => {
  const { text, expected } = filledTemplate();
  const zw = text.replace('សរុបឈ្មោះ', 'សរុប\u200Bឈ្មោះ').replace('ភ្ញៀវចូលគ្រប់ផេក', 'ភ្ញៀវ\u200Bចូលគ្រប់ផេក');
  assert.deepEqual(parseBulkReport(zw).summary.counters, expected);
});
