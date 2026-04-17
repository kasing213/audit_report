import { Temperature } from '../constants/temperature';

interface KeywordRule {
  temperature: Temperature;
  patterns: RegExp[];
}

const KEYWORD_RULES: KeywordRule[] = [
  {
    temperature: 'hot',
    patterns: [
      /\bdeposit\b/i,
      /\bready\s+to\s+buy\b/i,
      /\bbuy\s+now\b/i,
      /\bsite\s+visit\b/i,
      /\bvisit(ed)?\s+site\b/i,
      /\bsigned?\b/i,
      /\bcontract\b/i,
      /\bvery\s+interested\b/i,
      /\bintend\s+to\s+(buy|purchase)\b/i,
      /\botp\b/i,
      /មកមើលហើយ/,
      /បង់កក់/,
      /ព្រមទិញ/,
      /ចាប់អារម្មណ៍ខ្លាំង/
    ]
  },
  {
    temperature: 'warm',
    patterns: [
      /\bthinking\b/i,
      /\bconsider(ing)?\b/i,
      /\bfollow\s*up\b/i,
      /\bcall\s*back\b/i,
      /\btomorrow\b/i,
      /\bnext\s+week\b/i,
      /\bsend\s+(more\s+)?info\b/i,
      /\binterested\b/i,
      /\bmaybe\b/i,
      /\bwill\s+decide\b/i,
      /\bmight\b/i,
      /គិត/,
      /ទាក់ទង/,
      /ព្រឹកស្អែក/,
      /ថ្ងៃស្អែក/,
      /មកមើលថ្ងៃ/,
      /ចាំមើល/
    ]
  },
  {
    temperature: 'cold',
    patterns: [
      /\bnot\s+interested\b/i,
      /\bno\s+interest\b/i,
      /\btoo\s+expensive\b/i,
      /\bno\s+reply\b/i,
      /\bnot?\s+answer/i,
      /\bghost(ed)?\b/i,
      /\bstop\b/i,
      /\bcancel(led)?\b/i,
      /\brejected\b/i,
      /\bbusy\b/i,
      /\bcan(not|'t|t)\s+afford\b/i,
      /\bwrong\s+number\b/i,
      /មិនចាប់អារម្មណ៍/,
      /ថ្លៃពេក/,
      /មិនទទួល/,
      /មិនឆ្លើយ/,
      /បោះបង់/
    ]
  }
];

export function classifyByRules(statusText: string): Temperature | null {
  if (!statusText) return null;

  // Priority: hot > cold > warm. Hot signals are the strongest; cold is explicit decline;
  // warm is the softest signal so we check it last to avoid overriding explicit decline.
  for (const temp of ['hot', 'cold', 'warm'] as const) {
    const rule = KEYWORD_RULES.find((r) => r.temperature === temp);
    if (!rule) continue;
    if (rule.patterns.some((p) => p.test(statusText))) {
      return temp;
    }
  }

  return null;
}
