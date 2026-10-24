import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCloseSellReport } from '../../src/parser/close-sell-parser';

// Mirrors the template the bot hands out (help-command buildCloseSellTemplate),
// with the fields under test filled in. Empty fields stay as bare `X=` lines,
// which is how staff actually paste it back.
function template(f: {
  leader?: string; closer?: string; booked?: string; notBooked?: string;
  origin?: string; tooExpensive?: string; businessOwners?: string; workers?: string;
}): string {
  return [
    '💯Close sell',
    '#របាយការណ៍ថ្ងៃទី 24/10/26',
    '',
    '🚩page TestPage',
    'B/Close sell',
    '1.Date visited',
    '   4/លេខទូរស័ព្ទ = 012345678',
    '       a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង= 24/10/26',
    '2.លទ្ឋផលការបិទលក់ខាងក្រោម',
    `   1/ចំនួនកក់=${f.booked ?? ''}`,
    `   2/មិនទាន់កក់=${f.notBooked ?? ''}`,
    '   3/ផ្សេងៗ=',
    '   ទីតាំងដូចខាងក្រោម',
    '   1/រាយឈ្មោះអ្នកដឹកនាំមើលគំរោង=',
    `       a.=${f.leader ?? ''}`,
    '       b.=',
    '       c.=',
    '       d.=',
    '       e.Other=',
    `   2/ឈ្មោះអ្នកបិទលក់=${f.closer ?? ''}`,
    `   3/ភ្ញៀវមកពី=${f.origin ?? ''}`,
    '   4/បញ្ហាភ្ញៀវដូចខាងក្រោម',
    `      a.ថ្លៃពេក=${f.tooExpensive ?? ''}`,
    '      b.ទីតាំងមិនត្រូវ=',
    '4.ស្ថានភាពហិរញ្ញវត្ថុ=',
    `  3/អ្នករកសុី=${f.businessOwners ?? ''}`,
    `  4/អ្នកធ្វើការ=${f.workers ?? ''}`,
    '5.បរិយាយផ្សេងៗ='
  ].join('\n');
}

test('close-sell: tour leader is the follower, closer stays the closer', () => {
  const p = parseCloseSellReport(template({ leader: 'Dara', closer: 'Sok', booked: '1', notBooked: '0' }))!;
  assert.equal(p.follower, 'Dara');
  assert.equal(p.closer, 'Sok');
  assert.deepEqual(p.tour_leaders, ['Dara']);
  assert.equal(p.booked, 1);
  assert.equal(p.not_booked, 0);
  assert.match(p.packed_note, /អ្នកបិទលក់៖ Sok/);
});

test('close-sell: closer alone is never promoted to follower', () => {
  const p = parseCloseSellReport(template({ closer: 'Sok' }))!;
  assert.equal(p.follower, null);
  assert.equal(p.closer, 'Sok');
});

test('close-sell: empty fields do not swallow the next template line', () => {
  const p = parseCloseSellReport(template({}))!;
  assert.equal(p.follower, null);
  assert.equal(p.closer, null);
  assert.equal(p.origin, null);
  assert.deepEqual(p.tour_leaders, []);
  assert.equal(p.booked, 0);
  assert.equal(p.not_booked, 0);
  assert.deepEqual(p.obstacles, []);
  assert.equal(p.primary_reason_code, null);
  assert.equal(p.financial.business_owners, null);
  assert.equal(p.financial.workers, null);
});

test('close-sell: booked / not-booked counts are read per line', () => {
  const p = parseCloseSellReport(template({ booked: '', notBooked: '1' }))!;
  assert.equal(p.booked, 0);
  assert.equal(p.not_booked, 1);
});

test('close-sell: money in hand and family members are recorded', () => {
  const text = template({}).replace(
    '4.ស្ថានភាពហិរញ្ញវត្ថុ=',
    '4.ស្ថានភាពហិរញ្ញវត្ថុ=\n  1/មានលុយក្នងដៃ=500$-1000$\n  5/សមាជិកគ្រួសារ=2'
  );
  const p = parseCloseSellReport(text)!;
  assert.equal(p.financial.cash_in_hand, '500$-1000$');
  assert.equal(p.financial.family_members, 2);
  assert.match(p.packed_note, /លុយក្នុងដៃ=500\$-1000\$/);
  assert.match(p.packed_note, /សមាជិកគ្រួសារ=2/);
});

test('close-sell: §1 wants, first contact, and count details are kept as typed', () => {
  const text = template({})
    .replace('1.Date visited', '1.Date visited\n   1/ចង់បានដីឡូត៍លេខ=1\n   2/ចង់បានផ្ទះលេខ=')
    .replace('       a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង= 24/10/26',
      '       a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង= 24/10/26\n       b.ថ្ងៃ.ខែ.ឆ្នាំទាក់ទងដំបូងខាងក្រោម/\n          1/1-3day=1\n          2/4-7day=')
    .replace('  3/អ្នករកសុី=', '  3/អ្នករកសុី=1(លក់ចាបហួយ)')
    .replace('4.ស្ថានភាពហិរញ្ញវត្ថុ=', '4.ស្ថានភាពហិរញ្ញវត្ថុ=\n  7/អត្តចរិតខាងក្រោម\n     a.ល្អ=1');
  const p = parseCloseSellReport(text)!;
  assert.deepEqual(p.wants, [{ label: 'ចង់បានដីឡូត៍លេខ', value: '1' }]);
  assert.equal(p.first_contact, '1-3day');
  assert.equal(p.financial.business_owners, 1);
  assert.equal(p.financial.details.business_owners, 'លក់ចាបហួយ');
  assert.match(p.packed_note, /ចង់បានដីឡូត៍លេខ=1/);
  assert.match(p.packed_note, /ទាក់ទងដំបូង=1-3day/);
  assert.match(p.packed_note, /អ្នករកសុី=1 \(លក់ចាបហួយ\)/);
  assert.match(p.packed_note, /អត្តចរិត=ល្អ/);
});

test('close-sell: empty money-in-hand stays null', () => {
  const text = template({}).replace(
    '4.ស្ថានភាពហិរញ្ញវត្ថុ=',
    '4.ស្ថានភាពហិរញ្ញវត្ថុ=\n  1/មានលុយក្នុងដៃ=\n    a ការវាយតំលៃលទ្ឋភាពភ្ញៀខាងក្រោម'
  );
  assert.equal(parseCloseSellReport(text)!.financial.cash_in_hand, null);
});

test('close-sell: Khmer digits are accepted in counts', () => {
  const p = parseCloseSellReport(template({ booked: '១', notBooked: '២' }))!;
  assert.equal(p.booked, 1);
  assert.equal(p.not_booked, 2);
});
