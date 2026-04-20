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

console.log(failures === 0 ? `\nALL GOOD` : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
