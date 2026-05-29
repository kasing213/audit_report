import { toInternationalPhone } from '../utils/phone-utils';
import { isReasonCode, ReasonCode } from '../constants/reason-codes';
import { getTodayDate } from '../utils/time';

// Strict regex parser for the Close-sell / Customer Potential template.
// Both headers share the same numbered-section template body; they differ only
// in the header word ("Close sell" vs "Customer Potential") and the "B/" tag.

export type CloseSellHeaderKind = 'close-sell' | 'customer-potential';

export interface CloseSellParseResult {
  kind: CloseSellHeaderKind;
  date: string;
  page: string | null;
  phone: string | null;            // slash-joined when multi-phone (e.g. "0123/0987")
  phones: string[];                // individual phones, for lookups
  follower: string | null;         // §2.loc.2 closer, else first §2.loc.1 name
  closer: string | null;           // §2.loc.2 only
  tour_leaders: string[];          // §2.loc.1 a-e non-empty
  origin: string | null;           // §2.loc.3 ភ្ញៀវមកពី
  booked: number;                  // §2.1.1 ចំនួនកក់
  not_booked: number;              // §2.1.2 មិនទាន់កក់
  result_note: string | null;      // §2.3 ផ្សេងៗ
  obstacles: Array<{ letter: string; text: string }>;  // §2.loc.4 non-empty
  primary_reason_code: ReasonCode | null;  // first obstacle letter mapped to A-J
  financial: {
    capability: 'good' | 'medium' | 'weak' | null;  // §4.1.a (ល្អ/មធ្យម/ខ្សោយ)
    monthly_income: string | null;                   // §4.2 raw
    business_owners: number | null;                  // §4.3
    workers: number | null;                          // §4.4
    family_members: number | null;                   // §4.5
    earners: number | null;                          // §4.6
    character: 'good' | 'medium' | 'weak' | null;    // §4.7 (ល្អ/មធ្យម/អន់)
  };
  description: string | null;       // §5 បរិយាយផ្សេងៗ
  packed_note: string;              // joined note for storage
  raw_text: string;
  warnings: string[];
}

const REASON_LETTER_TO_CODE: Record<string, ReasonCode> = {
  a: 'A', b: 'B', c: 'C', d: 'D', e: 'E',
  f: 'F', g: 'G', h: 'H', i: 'I', j: 'J'
};

function parseDdMmYy(raw: string): string | null {
  const m = raw.match(/(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  let year = parseInt(m[3], 10);
  if (year < 100) year = 2000 + year;
  if (day < 1 || day > 31 || month < 1 || month > 12 || year < 2000 || year > 2100) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function cleanPhoneDigits(raw: string): string {
  return raw.replace(/[^\d+]/g, '');
}

function isPhoneCandidate(raw: string): boolean {
  const digits = cleanPhoneDigits(raw).replace(/^\+/, '');
  if (digits.length < 8) return false;
  if (/^0+$/.test(digits)) return false;
  return true;
}

/**
 * Detect Close-sell or Customer Potential template header.
 * Returns null if neither marker is present.
 */
export function detectCloseSellKind(text: string): CloseSellHeaderKind | null {
  if (/💯\s*Close\s*sell\b/i.test(text) || /(^|\n)\s*B\s*\/\s*Close\s*sell\b/im.test(text)) {
    return 'close-sell';
  }
  if (/💯\s*Customer\s*Potential\b/i.test(text) || /(^|\n)\s*B\s*\/\s*Customer\s*Potential\b/im.test(text)) {
    return 'customer-potential';
  }
  return null;
}

/**
 * Strict structural check — must have the header marker AND at least one
 * numbered template section (§1.Date or §2.លទ្ឋផល).
 */
export function detectCloseSellReport(text: string): boolean {
  if (!text || text.length < 30) return false;
  if (detectCloseSellKind(text) == null) return false;
  const hasSection1 = /(^|\n)\s*1\s*\.\s*Date\s+(visited|captured)/i.test(text);
  const hasSection2 = /(^|\n)\s*2\s*\.\s*លទ្ឋផល/.test(text);
  return hasSection1 || hasSection2;
}

interface SectionMap {
  s1: string;   // §1 Date visited
  s2: string;   // §2 លទ្ឋផល
  s4: string;   // §4 ស្ថានភាពហិរញ្ញវត្ថុ
  s5: string;   // §5 បរិយាយផ្សេងៗ
  preamble: string;  // text before §1 (page / report header)
}

function splitSections(text: string): SectionMap {
  // Section anchors are lines that start with `N.` at column 0 (possibly after
  // BOM/space) where N ∈ {1,2,4,5}. The template skips §3 historically.
  const anchorRegex = /(^|\n)(\s*)(1\s*\.\s*Date\s+(?:visited|captured)|2\s*\.\s*លទ្ឋផល[^\n]*|4\s*\.\s*ស្ថានភាពហិរញ្ញវត្ថុ[^\n]*|5\s*\.\s*បរិយាយផ្សេងៗ[^\n]*)/g;
  const marks: Array<{ kind: '1' | '2' | '4' | '5'; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = anchorRegex.exec(text)) !== null) {
    const head = m[3].trimStart()[0];
    if (head === '1' || head === '2' || head === '4' || head === '5') {
      const idx = m.index + m[1].length + m[2].length;
      marks.push({ kind: head, index: idx });
    }
  }
  marks.sort((a, b) => a.index - b.index);

  const sections: SectionMap = { s1: '', s2: '', s4: '', s5: '', preamble: '' };
  const first = marks[0];
  sections.preamble = first ? text.slice(0, first.index) : text;
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = text.slice(start, end);
    if (marks[i].kind === '1') sections.s1 = body;
    else if (marks[i].kind === '2') sections.s2 = body;
    else if (marks[i].kind === '4') sections.s4 = body;
    else if (marks[i].kind === '5') sections.s5 = body;
  }
  return sections;
}

function extractPage(preamble: string): string | null {
  for (const line of preamble.split('\n')) {
    const trimmed = line.trim().replace(/^🚩\s*/, '');
    const m = trimmed.match(/^(?:page|Page|ផេក)\s+(.+)$/);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

function extractReportDate(preamble: string): string | null {
  for (const line of preamble.split('\n')) {
    if (/របាយការណ៍|ថ្ងៃទី/.test(line)) {
      const parsed = parseDdMmYy(line);
      if (parsed) return parsed;
    }
  }
  return null;
}

function extractPhonesFromS1(s1: string): string[] {
  // §1.4 line: "4/លេខទូរស័ព្ទ = 0123/0987" — accept '/', '-', spaces, parens between digits.
  const m = s1.match(/លេខទូរស័ព្ទ\s*=\s*([\d+\-\s()\/]+)/);
  if (!m) return [];
  const raw = m[1].trim();
  // Split on `/` to get candidate phones, then normalize.
  const candidates = raw.split('/').map(s => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const c of candidates) {
    if (!isPhoneCandidate(c)) continue;
    try {
      const norm = toInternationalPhone(cleanPhoneDigits(c));
      if (norm) out.push(norm);
    } catch {
      // skip un-normalizable
    }
  }
  return out;
}

function extractVisitDate(s1: string): string | null {
  // §1.4.a "a ថ្ងៃ.ខែ.ឆ្នាំ.ម៉ោង= 28/05/26"
  const m = s1.match(/ថ្ងៃ\s*\.\s*ខែ\s*\.\s*ឆ្នាំ[^=]*=\s*([^\n]+)/);
  if (!m) return null;
  return parseDdMmYy(m[1]);
}

function extractCounts(s2: string): { booked: number; not_booked: number } {
  let booked = 0;
  let not_booked = 0;
  const bm = s2.match(/1\s*\/\s*ចំនួនកក់\s*=\s*0*(\d+)/);
  if (bm) booked = parseInt(bm[1], 10);
  const nm = s2.match(/2\s*\/\s*មិនទាន់កក់\s*=\s*0*(\d+)/);
  if (nm) not_booked = parseInt(nm[1], 10);
  return { booked, not_booked };
}

function extractResultNote(s2: string): string | null {
  // §2.3 ផ្សេងៗ= <text> (the result-note one, before "ទីតាំងដូចខាងក្រោម")
  const head = s2.split(/ទីតាំងដូចខាងក្រោម/)[0] ?? s2;
  const m = head.match(/3\s*\/\s*ផ្សេងៗ\s*=\s*([^\n]+)/);
  if (!m) return null;
  const v = m[1].trim();
  return v || null;
}

function extractTourLeaders(s2: string): string[] {
  // §2.loc.1 រាយឈ្មោះអ្នកដឹកនាំមើលគំរោង / រាយឈ្មោះអ្នកដឹកនាំទាក់ទងភ្ញៀវ block
  // followed by indented `a.= NAME`, `b.= NAME`, ... `e.Other=`
  const idx = s2.search(/រាយឈ្មោះអ្នកដឹកនាំ/);
  if (idx < 0) return [];
  // bound the block at the next "2/ឈ្មោះអ្នកបិទលក់" or "3/ភ្ញៀវមកពី" line
  const block = s2.slice(idx);
  const bound = block.search(/(2\s*\/\s*ឈ្មោះអ្នកបិទលក់|3\s*\/\s*ភ្ញៀវមកពី)/);
  const region = bound > 0 ? block.slice(0, bound) : block;
  const names: string[] = [];
  const re = /^\s*([a-eA-E])\s*[\.\)]?\s*=\s*([^\n]*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) {
    const v = m[2].trim().replace(/^Other\s*$/i, '');
    if (v) names.push(v);
  }
  return names;
}

function extractCloser(s2: string): string | null {
  const m = s2.match(/2\s*\/\s*ឈ្មោះអ្នកបិទលក់\s*=\s*([^\n]+)/);
  if (!m) return null;
  const v = m[1].trim();
  return v || null;
}

function extractOrigin(s2: string): string | null {
  const m = s2.match(/3\s*\/\s*ភ្ញៀវមកពី\s*=\s*([^\n]+)/);
  if (!m) return null;
  const v = m[1].trim();
  return v || null;
}

function extractObstacles(s2: string): Array<{ letter: string; text: string }> {
  // §2.loc.4 បញ្ហាភ្ញៀវ block — a-I letters with values.
  const idx = s2.search(/4\s*\/\s*បញ្ហាភ្ញៀវ/);
  if (idx < 0) return [];
  const block = s2.slice(idx);
  const out: Array<{ letter: string; text: string }> = [];
  // Look for lines like "a.ថ្លៃពេក=1" or "I.ផ្សេងៗ= text". Letters a-j (and I).
  const re = /^\s*([a-jA-J])\s*[\.\)]?\s*([^=\n]*?)\s*=\s*([^\n]*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const letter = m[1].toLowerCase();
    const label = m[2].trim();
    const value = m[3].trim();
    if (!value || value === '0') continue;
    out.push({ letter, text: label ? `${label}=${value}` : value });
  }
  return out;
}

function extractFinancial(s4: string): CloseSellParseResult['financial'] {
  const fin: CloseSellParseResult['financial'] = {
    capability: null,
    monthly_income: null,
    business_owners: null,
    workers: null,
    family_members: null,
    earners: null,
    character: null
  };
  // §4.1.a ការវាយតំលៃលទ្ឋភាព (ល្អ / មធ្យម / ខ្សោយ) — Khmer digits ១ ២ ៣ prefix.
  const capBlock = s4.match(/ការវាយតំលៃ[^=]*\s*([\s\S]*?)(?=\n\s*2\s*\/|$)/);
  if (capBlock) {
    if (/[១1]\s*\.\s*ល្អ\s*=\s*0*[1-9]/.test(capBlock[1])) fin.capability = 'good';
    else if (/[២2]\s*\.\s*មធ្យម\s*=\s*0*[1-9]/.test(capBlock[1])) fin.capability = 'medium';
    else if (/[៣3]\s*\.\s*ខ្សោយ\s*=\s*0*[1-9]/.test(capBlock[1])) fin.capability = 'weak';
  }
  const inc = s4.match(/2\s*\/\s*លទ្ឋភាពចំណូល[^=]*=\s*([^\n]*)/);
  if (inc && inc[1].trim()) fin.monthly_income = inc[1].trim();
  const bo = s4.match(/3\s*\/\s*អ្នករកសុី\s*=\s*0*(\d+)/);
  if (bo) fin.business_owners = parseInt(bo[1], 10);
  const wk = s4.match(/4\s*\/\s*អ្នកធ្វើការ\s*=\s*0*(\d+)/);
  if (wk) fin.workers = parseInt(wk[1], 10);
  const fm = s4.match(/5\s*\/\s*សមាជិកគ្រួសារ\s*=\s*0*(\d+)/);
  if (fm) fin.family_members = parseInt(fm[1], 10);
  const ern = s4.match(/6\s*\/\s*ចំនួនអ្នករកចំណូល[^=]*=\s*0*(\d+)/);
  if (ern) fin.earners = parseInt(ern[1], 10);
  const charBlock = s4.match(/7\s*\/\s*អត្តចរិត[\s\S]*$/);
  if (charBlock) {
    if (/a\s*\.\s*ល្អ\s*=\s*0*[1-9]/i.test(charBlock[0])) fin.character = 'good';
    else if (/b\s*\.\s*មធ្យម\s*=\s*0*[1-9]/i.test(charBlock[0])) fin.character = 'medium';
    else if (/c\s*\.\s*អន់\s*=\s*0*[1-9]/i.test(charBlock[0])) fin.character = 'weak';
  }
  return fin;
}

function extractDescription(s5: string): string | null {
  // §5 បរិយាយផ្សេងៗ= text  (header itself is on the same line as the marker).
  const m = s5.match(/បរិយាយផ្សេងៗ\s*=\s*([\s\S]*)$/);
  if (!m) return null;
  const v = m[1].trim();
  return v || null;
}

function packNote(p: {
  result_note: string | null;
  origin: string | null;
  obstacles: Array<{ letter: string; text: string }>;
  financial: CloseSellParseResult['financial'];
  description: string | null;
  tour_leaders: string[];
  closer: string | null;
}): string {
  const parts: string[] = [];
  if (p.result_note) parts.push(p.result_note);
  if (p.origin) parts.push(`ភ្ញៀវមកពី${p.origin}`);
  for (const ob of p.obstacles) parts.push(ob.text);
  if (p.financial.capability) parts.push(`លទ្ឋភាព=${p.financial.capability}`);
  if (p.financial.monthly_income) parts.push(`ចំណូល/ខែ=${p.financial.monthly_income}`);
  if (p.financial.business_owners != null) parts.push(`អ្នករកសុី=${p.financial.business_owners}`);
  if (p.financial.workers != null) parts.push(`អ្នកធ្វើការ=${p.financial.workers}`);
  if (p.financial.family_members != null) parts.push(`សមាជិកគ្រួសារ=${p.financial.family_members}`);
  if (p.financial.earners != null) parts.push(`អ្នករកចំណូល=${p.financial.earners}`);
  if (p.financial.character) parts.push(`អត្តចរិត=${p.financial.character}`);
  // tour leaders only when the closer is empty (otherwise they're redundant
  // — closer is the same person or the lead-tour was the same event).
  if (!p.closer && p.tour_leaders.length > 0) {
    parts.push(`អ្នកដឹកនាំ៖ ${p.tour_leaders.join(', ')}`);
  }
  if (p.description) parts.push(p.description);
  // Dedup adjacent identical pieces (template repeats §2.3 = §2.loc.4.I = §5 often).
  const deduped: string[] = [];
  for (const part of parts) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== part) deduped.push(part);
  }
  return deduped.join('; ');
}

export function parseCloseSellReport(text: string): CloseSellParseResult | null {
  const kind = detectCloseSellKind(text);
  if (!kind) return null;

  const warnings: string[] = [];
  const sections = splitSections(text);
  if (!sections.s1 && !sections.s2) {
    return null;
  }

  const page = extractPage(sections.preamble);
  const reportDate = extractReportDate(sections.preamble);
  const visitDate = extractVisitDate(sections.s1);
  const date = visitDate || reportDate || getTodayDate();
  if (!visitDate && !reportDate) warnings.push('No date found; using today');

  const phones = extractPhonesFromS1(sections.s1);
  const phone = phones.length ? phones.join('/') : null;
  if (!phone) warnings.push('No phone number found in §1.4');

  const { booked, not_booked } = extractCounts(sections.s2);
  const result_note = extractResultNote(sections.s2);
  const tour_leaders = extractTourLeaders(sections.s2);
  const closer = extractCloser(sections.s2);
  const origin = extractOrigin(sections.s2);
  const obstacles = extractObstacles(sections.s2);
  const primary_reason_code = (() => {
    for (const ob of obstacles) {
      const code = REASON_LETTER_TO_CODE[ob.letter];
      if (code && isReasonCode(code)) return code;
    }
    return null;
  })();
  const financial = extractFinancial(sections.s4);
  const description = extractDescription(sections.s5);

  const follower = closer || (tour_leaders[0] || null);
  const packed_note = packNote({
    result_note,
    origin,
    obstacles,
    financial,
    description,
    tour_leaders,
    closer
  });

  return {
    kind,
    date,
    page,
    phone,
    phones,
    follower,
    closer,
    tour_leaders,
    origin,
    booked,
    not_booked,
    result_note,
    obstacles,
    primary_reason_code,
    financial,
    description,
    packed_note,
    raw_text: text,
    warnings
  };
}
