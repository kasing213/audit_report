// The same 25/10/26 report as it actually reaches the bot: copied out of
// Telegram, most line breaks are gone and fields run on one line. Only the
// indented pieces Telegram shows as code blocks keep their breaks. This is the
// exact text the founder pasted into the sales group on 2026-10-26.
const R = (pre: string) => [
  `${pre}a.ថ្លៃពេក=`, 'b.ទីតាំងមិនត្រូវ=', 'c ខ្ញុំមិនមែនអ្នកសំរេច=', 'd គ្មានចំណាប់អារម្មណ៍=',
  'e.ត្រូវការកម្ចីច្រើន=', 'f.ជំពាក់គេច្រើន=', 'g.ខូចCBC=', 'h.ដីរឺផ្ទះតូចពេក=',
].join(' ');

export const FLAT_FORMAT_REPORT = [
  '_ស .💞Follow up #របាយការណ៍ថ្ងៃទី25/10/26',
  '/(ធ្វើប្រចាំថ្ងៃបន្ទាប់មុនម៉ោង10ព្រឹក ទោះចំថ្ងៃសំរាកក៏ដោយ) Jim 🚩Page Sun Tv (Biry) A.Follow (Boots Page) 1.Messege=8 a.Night(ទទួលពេលយប=3 b.PV(ភ្ញៀវខេត្ត)= 👉បរិយាយខេត្តណា= 2.ភ្ញៀវចូលគ្រប់ផេក= 3..Fack(ក្លែងក្លាយ)= 4.ភ្ញៀវធ្លាប់ទាក់ទងក្នុងMesseger= 5.ភ្ញៀវចាស់ធ្លាប់មើលគំរោងរួច= 6.Liked(ចុចមេដៃ)= 7.Other(ផ្សេងៗ) comment = ☎️9.Phone (ចំនួនលេខទូរស័ព្ទ)= 01 T el 0889475139 Name=long ya Pv= Tel 2= Name=',
  '       Pv=',
  'Tel3= 0 Nam=',
  '       Pv=',
  'Tel4=0 Name= Pv= Tel5=0 Name = Pv= Tel6= Name= Pv= Tel7=0 Name Pv= Tel8=0 Name= Pv= Tel9=0 Name= Pv= Tel10= Name= Pv= a.messageវ៉ៃលេខ',
  '1/Connected by message= 2/Connected by telegram= 3/Connected by Phone= 4/Connected by other= b.Comment= 1/Connected by message= 2/Connected by telegram= 3/Connected by Phone= 4/Connected by other= c. Callin 0 1/Connected by message= 2/Connected by telegram= 3/Connected by Phone= 4/Connected by other= d Group= 1/Connected by message= 2/Connected by telegram= 3/Connected by Phone= 4/Connected by other= e.Telegram= 1/Connected by message= 2/Connected by telegram= 3/Connected by Phone= 4/Connected by other= f Other= 1/Connected by message= 2/Connected by telegram= 3/Connected by Phone= 4/Connected by other',
  '👉 g.ភ្ញៀវឆ្លើយតបដូចខាងក្រោម Tel=0889475139',
  '  a.ថ្លៃពេក=1',
  '  b.ទីតាំងមិនត្រូវ=0',
  '! c ខ្ញុំមិនមែនអ្នកសំរេច d គ្មានចំណាប់អារម្មណ៍= e.ត្រូវការកម្ចីច្រើន= f.ជំពាក់គេច្រើន= g.ខូចCBC= h.ដីរឺផ្ទះតូចពេក= I.ចាំរកថ្ងៃទំនេរមកមើល 1 j.ផ្សេងៗ ' + [
    `${R('Tel2=0 ')} I.ចាំរកថ្ងៃទំនេរមកមើល=1 j.ផ្សេងៗ`,
    `${R('T3=,0 ')} I.ចាំរកថ្ងៃទំនេរមកមើល =1 j.ផ្សេងៗ=`,
    `${R('Tel4=0 ')} I.ចាំរកថ្ងៃទំនេរមកមើល= 1 j.ផ្សេងៗ=`,
    `${R('Tel5=0 ')} I.ចាំរកថ្ងៃទំនេរមកមើល=1 j.ផ្សេងៗ=!`,
    'Tel6=0 a.ថ្លៃពេក=1 b.ទីតាំងមិនត្រូវ= c ខ្ញុំមិនមែនអ្នកសំរេច= d គ្មានចំណាប់អារម្មណ៍= e.ត្រូវការកម្ចីច្រើន= f.ជំពាក់គេច្រើន= g.ខូចCBC= h.ដីរឺផ្ទះតូចពេក= I.ចាំរកថ្ងៃទំនេរមកមើល=1 9 j.ផ្សេងៗ=',
    'Tel7=0 a.ថ្លៃពេក= b.ទីតាំងមិនត្រូវ= c ខ្ញុំមិនមែនអ្នកសំរេច= d គ្មានចំណាប់អារម្មណ៍= e.ត្រូវការកម្ចីច្រើន= f.ជំពាក់គេច្រើន= g.ខូចCBC= 9 h.ដីរឺផ្ទះតូចពេក= I.ចាំរកថ្ងៃទំនេរមកមើល=1 j.ផ្សេងៗ=',
    `${R('Tel8= ')} I.ចាំរកថ្ងៃទំនេរមកមើល=1 j.ផ្សេងៗ=`,
    'Tel9= a.ថ្លៃពេក= b.ទីតាំងមិនត្រូវ= c ខ្ញុំមិនមែនអ្នកសំរេច= d គ្មានចំណាប់អារម្មណ៍= e.ត្រូវការកម្ចីច្រើន= f.ជំពាក់គេច្រើន= 0 g.ខូចCBC= h.ដីរឺផ្ទះតូចពេក= I.ចាំរកថ្ងៃទំនេរមកមើល=1 j.ផ្សេងៗ=',
    `${R('Tel10= ')} I.ចាំរកថ្ងៃទំនេរមកមើល= j.ផ្សេងៗ=0`,
  ].join(' ') + ' /🥰10 .Dating visit (សន្យាមកមើល) 1/លេខទូរស័ព្ = a ថ្ងៃ.ខែ.ឆ្នាំម៉ោង5:34pm20/10/26 b.ថ្ងៃ.ខែ.ឆ្នាំទាក់ទងដំបូងខាងក្រោម 1/1-3day=-2 days 2/4-7day= 3/8-15day= 4/16-31day= 5/1-3month= 6/3-6month= 7/6-12month= 8/Over12month= 2/លេខទូរស័ព្ =',
  '   a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង= 5:57pm4/10/26',
  '   b.ថ្ងៃ.ខែ.ឆ្នាំទាក់ទងដំបូងខាងក្រោម',
  '      1/1-3day=1',
  '      2/4-7day=',
  '      3/8-15day=',
  '      4/16-31day=',
  '      5/1-3month=',
  '      6/3-6month=',
  '      7/6-12month=',
  '      8/Over12month= ',
  '3/លេខទូរស័ព្ =',
  'a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង= b.ថ្ងៃ.ខែ.ឆ្នាំទាក់ទងដំបូងខាងក្រោមppឦ_ 4/លេខទរសព័=0 a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង b ថ្ងៃ.ខែ.ឆ្នាំ.ទាក។',
].join('\n');
