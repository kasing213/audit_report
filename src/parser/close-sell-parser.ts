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
  follower: string | null;         // first §2.loc.1 tour-leader name (never the closer)
  closer: string | null;           // §2.loc.2 ឈ្មោះអ្នកបិទលក់ only
  tour_leaders: string[];          // §2.loc.1 a-e non-empty
  origin: string | null;           // §2.loc.3 ភ្ញៀវមកពី
  booked: number;                  // §2.1.1 ចំនួនកក់
  not_booked: number;              // §2.1.2 មិនទាន់កក់
  result_note: string | null;      // §2.3 ផ្សេងៗ
  obstacles: Array<{ letter: string; text: string }>;  // §2.loc.4 non-empty
  primary_reason_code: ReasonCode | null;  // first obstacle letter mapped to A-J
  financial: {
    cash_in_hand: string | null;                     // §4.1 មានលុយក្នុងដៃ raw (e.g. "500$-1000$")
    capability: 'good' | 'medium' | 'weak' | null;  // §4.1.a (ល្អ/មធ្យម/ខ្សោយ)
    monthly_income: string | null;                   // §4.2 raw
    business_owners: number | null;                  // §4.3
    workers: number | null;                          // §4.4
    family_members: number | null;                   // §4.5
    earners: number | null;                          // §4.6
    character: 'good' | 'medium' | 'weak' | null;    // §4.7 (ល្អ/មធ្យម/អន់)
    // Text typed after a §4.3-4.6 count, e.g. "1(លក់ចាបហួយ)" → "លក់ចាបហួយ".
    details: Partial<Record<'business_owners' | 'workers' | 'family_members' | 'earners', string>>;
  };
  wants: Array<{ label: string; value: string }>;  // §1.1-1.3 ចង់បាន... non-empty
  first_contact: string | null;     // §1.4.b bucket label, e.g. "1-3day"
  description: string | null;       // §5 បរិយាយផ្សេងៗ
  packed_note: string;              // joined note for storage
  raw_text: string;
  warnings: string[];
}

// Display/storage labels — the template's own words, not the English enum.
export const CAPABILITY_KH: Record<'good' | 'medium' | 'weak', string> = { good: 'ល្អ', medium: 'មធ្យម', weak: 'ខ្សោយ' };
export const CHARACTER_KH: Record<'good' | 'medium' | 'weak', string> = { good: 'ល្អ', medium: 'មធ្យម', weak: 'អន់' };

/** §4 fields as [Khmer label, value-as-reported] pairs, in template order. */
export function financialLines(f: CloseSellParseResult['financial']): Array<[string, string]> {
  const withDetail = (n: number, d?: string) => (d ? `${n} (${d})` : String(n));
  const out: Array<[string, string]> = [];
  if (f.cash_in_hand) out.push(['លុយក្នុងដៃ', f.cash_in_hand]);
  if (f.capability) out.push(['លទ្ឋភាព', CAPABILITY_KH[f.capability]]);
  if (f.monthly_income) out.push(['ចំណូល/ខែ', f.monthly_income]);
  if (f.business_owners != null) out.push(['អ្នករកសុី', withDetail(f.business_owners, f.details.business_owners)]);
  if (f.workers != null) out.push(['អ្នកធ្វើការ', withDetail(f.workers, f.details.workers)]);
  if (f.family_members != null) out.push(['សមាជិកគ្រួសារ', withDetail(f.family_members, f.details.family_members)]);
  if (f.earners != null) out.push(['អ្នករកចំណូល', withDetail(f.earners, f.details.earners)]);
  if (f.character) out.push(['អត្តចរិត', CHARACTER_KH[f.character]]);
  return out;
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

// Staff type counts in Khmer digits as often as Latin ones (ចំនួនកក់=១).
function normalizeKhmerDigits(text: string): string {
  return text.replace(/[០-៩]/g, d => String(d.charCodeAt(0) - 0x17E0));
}

// NOTE: every field regex below uses `[ \t]*`, not `\s*`, around `=`. `\s`
// matches newlines, so an empty `X=` line would otherwise capture the next
// template line as its value (e.g. empty closer → "3/ភ្ញៀវមកពី=").

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
  const m = s1.match(/លេខទូរស័ព្ទ[ \t]*=[ \t]*([\d+\-\t ()\/]+)/);
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
  const m = s1.match(/ថ្ងៃ\s*\.\s*ខែ\s*\.\s*ឆ្នាំ[^=\n]*=[ \t]*([^\n]+)/);
  if (!m) return null;
  return parseDdMmYy(m[1]);
}

function extractWants(s1: string): Array<{ label: string; value: string }> {
  // §1.1-1.3 "1/ចង់បានដីឡូត៍លេខ=1" — kept verbatim; value meaning is the sender's.
  const out: Array<{ label: string; value: string }> = [];
  const re = /^[ \t]*[1-3][ \t]*\/[ \t]*(ចង់បាន[^=\n]*?)[ \t]*=[ \t]*([^\n]*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s1)) !== null) {
    const value = m[2].trim();
    if (value) out.push({ label: m[1].trim(), value });
  }
  return out;
}

function extractFirstContact(s1: string): string | null {
  // §1.4.b first-contact bucket: "1/1-3day=1" … "8/Over12month=". First marked bucket wins.
  const idx = s1.search(/ទាក់ទងដំបូង/);
  if (idx < 0) return null;
  const re = /^[ \t]*[1-8][ \t]*\/[ \t]*([^=\n]*?(?:day|month)[^=\n]*?)[ \t]*=[ \t]*([^\n]*)$/gim;
  const block = s1.slice(idx);
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const value = m[2].trim();
    if (!value || /^0+$/.test(value)) continue;
    const label = m[1].trim();
    return value === '1' ? label : `${label} (${value})`;
  }
  return null;
}

function extractCounts(s2: string): { booked: number; not_booked: number } {
  let booked = 0;
  let not_booked = 0;
  const bm = s2.match(/1[ \t]*\/[ \t]*ចំនួនកក់[ \t]*=[ \t]*0*(\d+)/);
  if (bm) booked = parseInt(bm[1], 10);
  const nm = s2.match(/2[ \t]*\/[ \t]*មិនទាន់កក់[ \t]*=[ \t]*0*(\d+)/);
  if (nm) not_booked = parseInt(nm[1], 10);
  return { booked, not_booked };
}

function extractResultNote(s2: string): string | null {
  // §2.3 ផ្សេងៗ= <text> (the result-note one, before "ទីតាំងដូចខាងក្រោម")
  const head = s2.split(/ទីតាំងដូចខាងក្រោម/)[0] ?? s2;
  const m = head.match(/3[ \t]*\/[ \t]*ផ្សេងៗ[ \t]*=[ \t]*([^\n]+)/);
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
  const re = /^[ \t]*([a-eA-E])[ \t]*[\.\)]?[ \t]*(?:Other)?[ \t]*=[ \t]*([^\n]*)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) {
    const v = m[2].trim().replace(/^Other\s*$/i, '');
    if (v) names.push(v);
  }
  return names;
}

function extractCloser(s2: string): string | null {
  const m = s2.match(/2[ \t]*\/[ \t]*ឈ្មោះអ្នកបិទលក់[ \t]*=[ \t]*([^\n]+)/);
  if (!m) return null;
  const v = m[1].trim();
  return v || null;
}

function extractOrigin(s2: string): string | null {
  const m = s2.match(/3[ \t]*\/[ \t]*ភ្ញៀវមកពី[ \t]*=[ \t]*([^\n]+)/);
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
  const re = /^[ \t]*([a-jA-J])[ \t]*[\.\)]?[ \t]*([^=\n]*?)[ \t]*=[ \t]*([^\n]*)$/gm;
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
    cash_in_hand: null,
    capability: null,
    monthly_income: null,
    business_owners: null,
    workers: null,
    family_members: null,
    earners: null,
    character: null,
    details: {}
  };
  // §4.1.a ការវាយតំលៃលទ្ឋភាព (ល្អ / មធ្យម / ខ្សោយ) — Khmer digits ១ ២ ៣ prefix.
  // The handed-out template misspells ក្នុង as ក្នង; accept both.
  const cash = s4.match(/1[ \t]*\/[ \t]*មានលុយក្ន(?:ុ)?ងដៃ[ \t]*=[ \t]*([^\n]*)/);
  if (cash && cash[1].trim()) fin.cash_in_hand = cash[1].trim();
  // Header line is skipped with [^\n]* — a `[^=]*` here would eat the "១.ល្អ"
  // label up to its `=`, so 'good' could never match.
  const capBlock = s4.match(/ការវាយតំលៃ[^\n]*([\s\S]*?)(?=\n\s*2\s*\/|$)/);
  if (capBlock) {
    if (/[១1][ \t]*\.[ \t]*ល្អ[ \t]*=[ \t]*0*[1-9]/.test(capBlock[1])) fin.capability = 'good';
    else if (/[២2][ \t]*\.[ \t]*មធ្យម[ \t]*=[ \t]*0*[1-9]/.test(capBlock[1])) fin.capability = 'medium';
    else if (/[៣3][ \t]*\.[ \t]*ខ្សោយ[ \t]*=[ \t]*0*[1-9]/.test(capBlock[1])) fin.capability = 'weak';
  }
  const inc = s4.match(/2[ \t]*\/[ \t]*លទ្ឋភាពចំណូល[^=\n]*=[ \t]*([^\n]*)/);
  if (inc && inc[1].trim()) fin.monthly_income = inc[1].trim();
  // Counts: the number, plus any text typed after it ("1(លក់ចាបហួយ)").
  const counts: Array<[keyof CloseSellParseResult['financial']['details'], RegExp]> = [
    ['business_owners', /3[ \t]*\/[ \t]*អ្នករកសុី[ \t]*=[ \t]*0*(\d+)([^\n]*)/],
    ['workers', /4[ \t]*\/[ \t]*អ្នកធ្វើការ[ \t]*=[ \t]*0*(\d+)([^\n]*)/],
    ['family_members', /5[ \t]*\/[ \t]*សមាជិកគ្រួសារ[ \t]*=[ \t]*0*(\d+)([^\n]*)/],
    ['earners', /6[ \t]*\/[ \t]*ចំនួនអ្នករកចំណូល[^=\n]*=[ \t]*0*(\d+)([^\n]*)/]
  ];
  for (const [key, re] of counts) {
    const m = s4.match(re);
    if (!m) continue;
    fin[key] = parseInt(m[1], 10);
    const extra = m[2].trim().replace(/^\((.*)\)$/, '$1').trim();
    if (extra) fin.details[key] = extra;
  }
  const charBlock = s4.match(/7\s*\/\s*អត្តចរិត[\s\S]*$/);
  if (charBlock) {
    if (/a[ \t]*\.[ \t]*ល្អ[ \t]*=[ \t]*0*[1-9]/i.test(charBlock[0])) fin.character = 'good';
    else if (/b[ \t]*\.[ \t]*មធ្យម[ \t]*=[ \t]*0*[1-9]/i.test(charBlock[0])) fin.character = 'medium';
    else if (/c[ \t]*\.[ \t]*អន់[ \t]*=[ \t]*0*[1-9]/i.test(charBlock[0])) fin.character = 'weak';
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
  booked: number;
  not_booked: number;
  wants: Array<{ label: string; value: string }>;
  first_contact: string | null;
}): string {
  const parts: string[] = [];
  // Lead events carry no count or closer column, so the note is where the
  // close / not-close result and the closer survive into storage.
  if (p.booked > 0) parts.push(`កក់=${p.booked}`);
  if (p.not_booked > 0) parts.push(`មិនទាន់កក់=${p.not_booked}`);
  if (p.closer) parts.push(`អ្នកបិទលក់៖ ${p.closer}`);
  for (const w of p.wants) parts.push(`${w.label}=${w.value}`);
  if (p.first_contact) parts.push(`ទាក់ទងដំបូង=${p.first_contact}`);
  if (p.result_note) parts.push(p.result_note);
  if (p.origin) parts.push(`ភ្ញៀវមកពី${p.origin}`);
  for (const ob of p.obstacles) parts.push(ob.text);
  for (const [label, value] of financialLines(p.financial)) parts.push(`${label}=${value}`);
  // The first tour leader is already stored as the follower; list them all
  // only when there is more than one.
  if (p.tour_leaders.length > 1) {
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
  // Parse a digit-normalized copy; raw_text below keeps the original.
  const sections = splitSections(normalizeKhmerDigits(text));
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
  const wants = extractWants(sections.s1);
  const first_contact = extractFirstContact(sections.s1);

  // Follower = the staff who followed/led the customer (§2.loc.1). The closer
  // (§2.loc.2) is a different role and is never promoted into follower.
  const follower = tour_leaders[0] || null;
  const packed_note = packNote({
    result_note,
    origin,
    obstacles,
    financial,
    description,
    tour_leaders,
    closer,
    booked,
    not_booked,
    wants,
    first_contact
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
    wants,
    first_contact,
    description,
    packed_note,
    raw_text: text,
    warnings
  };
}
