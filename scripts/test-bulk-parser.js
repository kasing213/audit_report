const { parseBulkReport } = require('../dist/parser/bulk-report-parser');

let failures = 0;
function check(name, cond, detail) {
  if (!cond) { failures++; console.error('FAIL', name, detail || ''); }
  else console.log(' OK ', name);
}

// === Fixture 1: empty template (no Tel phones) ===
const empty = `ស .💞Follow up
#របាយការណ៍ថ្ងៃទី18/4/26
Jim
🚩Paeលក់ដីឡូតិ ក្រុងភ្នំពេញ(ប៊ីរី)
A.Follow (Boots Page)
    1.Messege=8
       a.Night(ទទួលពេលយប់=3
Tel1=
Tel2=
`;

// === Fixture 2: filled with 3 Tel blocks + Dating ===
const filled = `#របាយការណ៍ថ្ងៃទី20/4/26
Jim
🚩Paeលក់ដីឡូតិ ក្រុងភ្នំពេញ(ប៊ីរី)
A.Follow (Boots Page)
    1.Messege=12
       a.Night=4
Tel1=070597666
       Name=Sok Dara
       Pv=PP
      a.ថ្លៃពេក=1
Tel2=0
Tel3=093724678
       Name=Srey Mom
       Pv=KDL
       b.ទីតាំងមិនត្រូវ=1
/🥰10 .Dating visit (សន្យាមកមើល)
   1/លេខទូរស័ព្ =070597666
       a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង  2pm 22/4/26
          1/1-3day=1
`;

// === Fixture 3: bug reproducer — spaces around = + no indentation ===
const repro = `Date 20/04/2026
Tel1 = 070597666
Name = Chan
a. ថ្លៃពេក = 1
Tel2 = 011228226
`;

// === Fixture 4: counters starting with A-J letters (F, C, H) ===
const counters = `Date 20/04/2026
Total = 42
Follow up = 15
Cold = 8
Hot = 3
Jim = 0
Tel1 = 070597666
`;

const r1 = parseBulkReport(empty);
check('empty: no drafts', r1.drafts.length === 0, `got ${r1.drafts.length}`);
check('empty: counters parsed', r1.summary.counters.messege === 8 && r1.summary.counters.night === 3, JSON.stringify(r1.summary.counters));

const r2 = parseBulkReport(filled);
check('filled: Tel1 drafted', r2.drafts.some(d => d.slot === 'Tel1'), JSON.stringify(r2.drafts.map(d => d.slot)));
check('filled: Tel3 drafted', r2.drafts.some(d => d.slot === 'Tel3'), '');
check('filled: Tel2 skipped (phone 0)', !r2.drafts.some(d => d.slot === 'Tel2'), '');
check('filled: Tel1 has reason A', r2.drafts.find(d => d.slot === 'Tel1')?.reason_code === 'A', '');
check('filled: Tel1 promise date set', r2.drafts.find(d => d.slot === 'Tel1')?.promise_date === '2026-04-22', '');

const r3 = parseBulkReport(repro);
check('repro: Tel1 present', r3.drafts.some(d => d.customer_phone === '+85570597666'), JSON.stringify(r3.drafts.map(d => ({ slot: d.slot, phone: d.customer_phone }))));
check('repro: Tel2 present', r3.drafts.some(d => d.customer_phone === '+85511228226'), '');

const r4 = parseBulkReport(counters);
check('counters: Total=42', r4.summary.counters.total === 42, JSON.stringify(r4.summary.counters));
check('counters: Follow up keeps F', r4.summary.counters.follow_up === 15, JSON.stringify(r4.summary.counters));
check('counters: Cold keeps C',      r4.summary.counters.cold === 8,      JSON.stringify(r4.summary.counters));
check('counters: Hot keeps H',       r4.summary.counters.hot === 3,       JSON.stringify(r4.summary.counters));
check('counters: Jim keeps J',       r4.summary.counters.jim === 0,       JSON.stringify(r4.summary.counters));

// === Fixture 5: Theary layout — reason codes in a separate bottom section, plus connection grid ===
const theary = `#របាយការណ៍ថ្ងៃទី25/02/26
Theary
🚩Page king  (បូរី)
A.Follow (Boots Page)
    1.Messege=5
       a.Night=2
Tel1=070597666
       Name=kasing
           Pv=PP
Tel2=
       Name=
           Pv=
Tel3=
       Name=
           Pv=
    a.Messager=
      1/Connected by message=2
      2/Connected by telegram=1
      3/Connected by Phone=0
      4/Connected by other=0
    b.Comment=
      1/Connected by message=0
      2/Connected by telegram=3
      3/Connected by Phone=0
      4/Connected by other=0
    c.Call in=
      1/Connected by message=0
      2/Connected by telegram=0
      3/Connected by Phone=4
      4/Connected by other=0
  👉 g.ភ្ញៀវឆ្លើយតបដូចខាងក្រោម
    Tel1=
      a.ថ្លៃពេក=1
      b.ទីតាំងមិនត្រូវ=
      j.ផ្សេងៗ=
  Tel2=
      a.ថ្លៃពេក=
      b.ទីតាំងមិនត្រូវ=1
      j.ផ្សេងៗ=
  Tel3=
      a.ថ្លៃពេក=
      b.ទីតាំងមិនត្រូវ=
      j.ផ្សេងៗ=
`;

const r5 = parseBulkReport(theary);
check('theary: exactly 1 draft',        r5.drafts.length === 1,                                        JSON.stringify(r5.drafts.map(d => ({ slot: d.slot, phone: d.customer_phone }))));
check('theary: Tel1 phone',             r5.drafts[0]?.customer_phone === '+85570597666',               JSON.stringify(r5.drafts[0]));
check('theary: Tel1 name',              r5.drafts[0]?.customer_name === 'kasing',                      JSON.stringify(r5.drafts[0]));
check('theary: Tel1 reason A (merged)', r5.drafts[0]?.reason_code === 'A',                             JSON.stringify(r5.drafts[0]));
check('theary: conn msgr/message=2',    r5.summary.counters.messager_connected_by_message === 2,       JSON.stringify(r5.summary.counters));
check('theary: conn msgr/telegram=1',   r5.summary.counters.messager_connected_by_telegram === 1,      JSON.stringify(r5.summary.counters));
check('theary: conn comment/telegram=3',r5.summary.counters.comment_connected_by_telegram === 3,       JSON.stringify(r5.summary.counters));
check('theary: conn call_in/phone=4',   r5.summary.counters.call_in_connected_by_phone === 4,          JSON.stringify(r5.summary.counters));
check('theary: no bare connected_by',   r5.summary.counters.connected_by_message === undefined,        JSON.stringify(r5.summary.counters));
check('theary: header messege=5',       r5.summary.counters.messege === 5,                             JSON.stringify(r5.summary.counters));
check('theary: header night=2',         r5.summary.counters.night === 2,                               JSON.stringify(r5.summary.counters));

// === Fixture 7: reason regex must not cross newlines ===
// Tel2 below has `a.=` (empty) then `b.=1`. The previous regex used `\s*=\s*`
// which swallowed the newline after `=` and captured the next line, flipping
// the reason to A. Expected reason for Tel2 is B.
const crossline = `#របាយការណ៍ថ្ងៃទី22/4/26
Theary
🚩Page test
Tel1=012345678
   Name=Sok Dara
   Pv=PP
   a.ថ្លៃពេក=1
   j.ផ្សេងៗ=
Tel2=012365478
   Name=kasing
   Pv=KD
   a.ថ្លៃពេក=
   b.ទីតាំងមិនត្រូវ=1
   c ខ្ញុំមិនមែនអ្នកសំរេច=
   j.ផ្សេងៗ=
`;
const r7 = parseBulkReport(crossline);
check('crossline: Tel1 reason A', r7.drafts.find(d => d.slot === 'Tel1')?.reason_code === 'A', JSON.stringify(r7.drafts));
check('crossline: Tel2 reason B', r7.drafts.find(d => d.slot === 'Tel2')?.reason_code === 'B', JSON.stringify(r7.drafts));

// === Fixture 8: two Dating entries with the same phone must not collide ===
// Entry 1 merges with Tel1 (sets promise_date = 22/4). Entry 2 (same phone,
// different day 23/4) must become its own dating-N draft rather than
// overwriting Tel1's date — otherwise the first visit is silently lost.
const twoDating = `#របាយការណ៍ថ្ងៃទី22/4/26
Theary
🚩Page test
Tel1=012345678
   Name=Sok Dara
   Pv=PP
   a.ថ្លៃពេក=1

🥰10 .Dating visit (សន្យាមកមើល)
   1/លេខទូរស័ព្ =012345678
      a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង= 2pm 22/4/26
   2/លេខទូរស័ព្ទ=012345678
      a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង= 3pm 23/4/2026
`;
const r8 = parseBulkReport(twoDating);
check('two-dating: exactly 2 drafts', r8.drafts.length === 2, JSON.stringify(r8.drafts.map(d => ({ slot: d.slot, promise: d.promise_date }))));
check('two-dating: Tel1 keeps 22/4 date',
  r8.drafts.find(d => d.slot === 'Tel1')?.promise_date === '2026-04-22',
  JSON.stringify(r8.drafts.find(d => d.slot === 'Tel1')));
check('two-dating: dating-N draft gets 23/4 date',
  r8.drafts.find(d => d.slot.startsWith('dating-'))?.promise_date === '2026-04-23',
  JSON.stringify(r8.drafts.find(d => d.slot.startsWith('dating-'))));
check('two-dating: dating-N inherits name from Tel1',
  r8.drafts.find(d => d.slot.startsWith('dating-'))?.customer_name === 'Sok Dara',
  JSON.stringify(r8.drafts.find(d => d.slot.startsWith('dating-'))));

// === Fixture 6: Jim regression — same filled fixture should still produce Tel1/Tel3 with reasons ===
const r6 = parseBulkReport(filled);
check('jim-regress: Tel1 draft',        r6.drafts.some(d => d.slot === 'Tel1' && d.customer_phone === '+85570597666'), JSON.stringify(r6.drafts.map(d => d.slot)));
check('jim-regress: Tel3 draft',        r6.drafts.some(d => d.slot === 'Tel3' && d.customer_phone === '+85593724678'), '');
check('jim-regress: Tel2 skipped',      !r6.drafts.some(d => d.slot === 'Tel2'), '');
check('jim-regress: Tel1 reason A',     r6.drafts.find(d => d.slot === 'Tel1')?.reason_code === 'A',   '');
check('jim-regress: Tel3 reason B',     r6.drafts.find(d => d.slot === 'Tel3')?.reason_code === 'B',   '');
check('jim-regress: Tel1 promise date', r6.drafts.find(d => d.slot === 'Tel1')?.promise_date === '2026-04-22', '');

console.log(failures === 0 ? `\nALL GOOD` : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
