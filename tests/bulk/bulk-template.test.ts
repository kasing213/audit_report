import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBulkReport } from '../../src/parser/bulk-report-parser';
import { HelpCommand } from '../../src/bot/commands/help-command';
import { COLLEAGUE_REPORT } from './colleague-fixture';

const template = (): string =>
  (new HelpCommand() as any).buildBulkCopyTemplate('Sales-management-group', '26/10/26');

const slot = (tpl: string, n: number): string => {
  const start = tpl.indexOf(`Tel${n}=`);
  const next = tpl.indexOf(`Tel${n + 1}=`);
  return tpl.slice(start, next > 0 ? next : tpl.indexOf('🥰'));
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
