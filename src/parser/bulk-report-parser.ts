import { toInternationalPhone } from '../utils/phone-utils';
import { isReasonCode, REASON_CODES, ReasonCode, REASON_CODE_LABELS } from '../constants/reason-codes';
import { getTodayDate } from '../utils/time';

export interface LeadEventDraft {
  slot: string;
  date: string;
  follower: string | null;
  page: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  reason_code: ReasonCode | null;
  note: string | null;
  promise_date: string | null;
  source_fragment: string;
  warnings: string[];
  include: boolean;
}

export interface BulkReportHeader {
  date: string;
  follower: string | null;
  page: string | null;
}

export interface BulkReportSummary {
  counters: Record<string, number>;
  raw_text: string;
}

export interface BulkReportParseResult {
  header: BulkReportHeader;
  summary: BulkReportSummary;
  drafts: LeadEventDraft[];
  warnings: string[];
  empty_slots: number;
}

const REASON_LETTER_TO_CODE: Record<string, ReasonCode> = {
  a: 'A', b: 'B', c: 'C', d: 'D', e: 'E',
  f: 'F', g: 'G', h: 'H', i: 'I', j: 'J'
};

function normalizeKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 40);
}

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
 * Normalize a phone field that may contain one or more slash-separated phones
 * (e.g. "0123/0987"). Returns slash-joined normalized phones, or null when
 * none of the candidates are valid.
 */
function normalizePhoneSegment(raw: string): string | null {
  const parts = raw.split('/').map(s => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (!isPhoneCandidate(p)) continue;
    try {
      const n = toInternationalPhone(cleanPhoneDigits(p));
      if (n) out.push(n);
    } catch {
      // skip un-normalizable
    }
  }
  return out.length ? out.join('/') : null;
}

function extractDate(lines: string[], warnings: string[]): string {
  for (const line of lines) {
    if (/ថ្ងៃទី|របាយការណ៍|Date|date/.test(line)) {
      const parsed = parseDdMmYy(line);
      if (parsed) return parsed;
    }
  }
  const today = getTodayDate();
  warnings.push(`No report date found; using today (${today})`);
  return today;
}

function extractFollower(lines: string[], dateLineIndex: number): string | null {
  for (let i = dateLineIndex + 1; i < Math.min(lines.length, dateLineIndex + 8); i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([A-Za-z][A-Za-z0-9 _.-]{0,30})$/);
    if (m) return m[1].trim();
  }
  return null;
}

function extractPage(lines: string[]): string | null {
  for (const line of lines) {
    const trimmed = line.trim().replace(/^🚩\s*/, '');
    if (/^(Pae|Page|ផេក)/i.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

function extractCounters(section: string): Record<string, number> {
  const counters: Record<string, number> = {};
  const lines = section.split('\n');
  // List-marker prefixes look like `1.`, `1)`, `A.`, `a)`, or nested combos
  // like `1.a.`. We require a `.`, `)`, or `/` separator so a bare leading
  // letter (F in "Follow up", C in "Cold", etc.) is NOT mistaken for a list
  // marker and eaten from the label.
  let currentCategory: string | null = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (/^\s*$/.test(line)) { currentCategory = null; continue; }

    // Category header for connection-breakdown grid: `a.Messager=`, `b.Comment=`,
    // `c.Call in=`, `d Group=`, `e.Telegram=`, `f Other=`. Value slot is empty.
    const catMatch = line.match(/^\s*([a-fA-F])[\.\)\s]+([A-Za-z][^=\n]*?)\s*=\s*$/);
    if (catMatch) {
      const catLatin = catMatch[2].match(/^([A-Za-z][A-Za-z0-9 _\/]*)/);
      currentCategory = catLatin ? (normalizeKey(catLatin[1]) || null) : null;
      continue;
    }

    // The team's full format writes the same headers looser (`a.messageវ៉ៃលេខ`,
    // `c. Callin 0`) with `1/Connected by ...` lines under each. A header that
    // is followed by a Connected-by line is a category, whatever its shape; a
    // number on it is that channel's total.
    const looseCat = line.match(/^\s*([a-fA-F])(?:[.)]|\s)\s*([A-Za-z][A-Za-z ]*)/);
    if (looseCat && !/Connected by/i.test(line) && /Connected by/i.test(lines[li + 1] || '')) {
      currentCategory = normalizeKey(looseCat[2]) || null;
      const total = line.match(/(?:=\s*|\s)(\d+)\s*$/);
      if (currentCategory && total) counters[currentCategory] = parseInt(total[1], 10);
      continue;
    }

    const match = line.match(/^\s*(?:\d+[.)/]\s*)?(?:[a-jA-J][.)/]\s*)?([A-Za-z][^=]*?)\s*=\s*(\d+)\s*$/);
    if (!match) continue;
    const rawLabel = match[1];
    const latinOnly = rawLabel.match(/^([A-Za-z][A-Za-z0-9 _\/]+)/);
    if (!latinOnly) continue;
    const key = normalizeKey(latinOnly[1]);
    const val = parseInt(match[2], 10);
    if (!key || !Number.isFinite(val)) continue;
    if (key === 'tel' || /^tel\d*$/.test(key)) continue;

    const isConnectedBy = /^connected_by_/.test(key);
    const finalKey = isConnectedBy && currentCategory ? `${currentCategory}_${key}` : key;
    counters[finalKey] = val;
  }
  return counters;
}

function findSectionBounds(text: string): { headerEnd: number; telStart: number; datingStart: number } {
  const telMatch = text.match(/\n\s*(?:☎️\s*)?\d*\.?\s*Phone\s*[（(]/i) || text.match(/\n\s*Tel\s*\d*\s*=/i);
  const telStart = telMatch ? telMatch.index ?? text.length : text.length;

  const datingRegex = /Dating visit|សន្យាមកមើល/;
  const datingMatch = datingRegex.exec(text);
  let datingStart = datingMatch ? datingMatch.index : text.length;
  // Back up to the start of the Dating line. Without a Dating section there is
  // nothing to back up from: doing it anyway cut off the report's last line.
  if (datingMatch && datingStart > 0) {
    const lineStart = text.lastIndexOf('\n', datingStart);
    if (lineStart >= 0) datingStart = lineStart;
  }

  return { headerEnd: telStart, telStart, datingStart };
}

interface TelBlock {
  num: number;
  value: string;
  body: string;
}

/**
 * Tel slot headers as staff really type them: `Tel1=0123`, `Tel 2=`, `Tel3= 0`,
 * `T3=,0`, `Tel=0889...` (no slot number) and `T el 0889475139` (no number, no
 * `=`). A header without a number is the slot after the previous one.
 */
function extractTelBlocks(region: string): TelBlock[] {
  const telRegex = /(^|\n)[ \t]*(?:[☎️☎][ \t]*)?T[ \t]*(?:e[ \t]*l?)?[ \t]*(\d{1,2})?[ \t]*(?:=|(?=[ \t]+[+\d]))[ \t]*([^\n]*)/gi;
  const starts: Array<{ num: number; index: number; value: string }> = [];
  let prev = 0;
  let m: RegExpExecArray | null;
  while ((m = telRegex.exec(region)) !== null) {
    const num = m[2] ? parseInt(m[2], 10) : prev + 1;
    if (!Number.isFinite(num) || num < 1 || num > 20) continue;
    prev = num;
    starts.push({ num, index: m.index + m[1].length, value: m[3] });
  }

  return starts.map((s, i) => ({
    num: s.num,
    value: s.value,
    body: region.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : region.length),
  }));
}

function readPhone(value: string): string | null {
  const m = value.match(/^[,;:\s]*([\d+\-\s()\/]+)/);
  return m ? normalizePhoneSegment(m[1].trim()) : null;
}

interface MarkedReason {
  code: ReasonCode;
  value: string;
}

/**
 * Every a-j line with a value other than empty or 0, in order. Accepts
 * `a.ថ្លៃពេក=1`, `c ខ្ញុំ...=1` and `I.ចាំរក... 1` (a space instead of `=`).
 * Whitespace is [ \t] only, so an empty `a.ថ្លៃពេក=` line can't take the next
 * line as its value (which would flip `b.…=1` into reason A).
 */
function readReasons(body: string): MarkedReason[] {
  const out: MarkedReason[] = [];
  const re = /^[ \t]*([a-jA-J])(?:[ \t]*[.)][ \t]*|[ \t]+|(?=[ \t]*=))([^=\n]*?)[ \t]*(?:=[ \t]*([^\n]*?)|[ \t]+(\d+))?[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const value = (m[3] ?? m[4] ?? '').trim();
    if (!value || value === '0') continue;
    const code = REASON_LETTER_TO_CODE[m[1].toLowerCase()];
    if (code) out.push({ code, value });
  }
  return out;
}

interface SlotPartial {
  num: number;
  customerPhone: string | null;
  name: string | null;
  province: string | null;
  reasons: MarkedReason[];
  sourceFragments: string[];
  warnings: string[];
}

function parseTelBlockPartial(block: TelBlock, withReasons: boolean): SlotPartial {
  const warnings: string[] = [];
  const body = block.body;

  // Fence: the /help template places `B.ប្រភពទំនាក់ទំនង (Connected by)` with its
  // a-f grid between Tel1's `j.ផ្សេងៗ=` line and `Tel2=`, which means the grid
  // sits inside Tel1's body per extractTelBlocks' bounds. Truncate the
  // extraction region at that line so `a.Messenger=5` can't be misread as
  // Tel1's reason A when Tel1's real a-j are all empty. The full body is
  // still preserved in sourceFragments for display.
  const fenceRegex = /^[ \t]*[A-Z][.\s)\]]+[^\n]*Connected by[^\n]*$/mi;
  const fenceMatch = fenceRegex.exec(body);
  const scanBody = fenceMatch ? body.slice(0, fenceMatch.index) : body;

  let customerPhone: string | null = null;
  try {
    customerPhone = readPhone(block.value);
  } catch {
    warnings.push('Phone normalization failed');
  }

  // `Nam=` is a common typo for `Name=`.
  let name: string | null = null;
  const nameMatch = scanBody.match(/\bName?\s*=[ \t]*([^\n]+)/i);
  if (nameMatch) {
    const v = nameMatch[1].trim();
    if (v) name = v;
  }

  let province: string | null = null;
  const pvMatch = scanBody.match(/\bPv\s*=[ \t]*([^\n]+)/i);
  if (pvMatch) {
    const v = pvMatch[1].trim();
    if (v) province = v;
  }

  return {
    num: block.num,
    customerPhone,
    name,
    province,
    reasons: withReasons ? readReasons(scanBody) : [],
    sourceFragments: [body.trim()],
    warnings
  };
}

function mergeSlotPartials(partials: SlotPartial[]): Map<number, SlotPartial> {
  const merged = new Map<number, SlotPartial>();
  for (const p of partials) {
    const existing = merged.get(p.num);
    if (!existing) {
      merged.set(p.num, { ...p, sourceFragments: [...p.sourceFragments], warnings: [...p.warnings] });
      continue;
    }
    if (!existing.customerPhone && p.customerPhone) existing.customerPhone = p.customerPhone;
    if (!existing.name && p.name) existing.name = p.name;
    if (!existing.province && p.province) existing.province = p.province;
    if (!existing.reasons.length && p.reasons.length) existing.reasons = p.reasons;
    existing.sourceFragments.push(...p.sourceFragments);
    existing.warnings.push(...p.warnings);
  }
  return merged;
}

/**
 * The team's full format lists the a-j reasons in a second run of Tel blocks
 * under `👉 g.ភ្ញៀវឆ្លើយតបដូចខាងក្រោម`, after the phones and the Connected-by
 * grid. Returns that heading line's bounds, or null for the bot's short
 * template, where each Tel carries its reasons inline.
 */
function findReasonList(text: string, end: number): { start: number; end: number } | null {
  const m = /^[^\n]*ភ្ញៀវឆ្លើយតប[^\n]*$/m.exec(text.slice(0, end));
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/** Attach each reason block to its slot: by phone when it has one, else by slot number. */
function applyReasonList(merged: Map<number, SlotPartial>, region: string): void {
  for (const block of extractTelBlocks(region)) {
    const reasons = readReasons(block.body);
    if (!reasons.length) continue;
    let phone: string | null = null;
    try { phone = readPhone(block.value); } catch { phone = null; }
    const byPhone = phone
      ? Array.from(merged.values()).find(s => (s.customerPhone ?? '').split('/').includes(phone as string))
      : undefined;
    const target = byPhone ?? merged.get(block.num);
    if (!target) continue;
    if (!target.reasons.length) target.reasons = reasons;
    target.sourceFragments.push(block.body.trim());
  }
}

function slotPartialToDraft(p: SlotPartial, header: BulkReportHeader): LeadEventDraft | null {
  if (!p.customerPhone) return null;
  const [primary, ...more] = p.reasons;
  const noteParts: string[] = [];
  if (p.province) noteParts.push(`Province: ${p.province}`);
  if (primary?.code === 'J' && !/^\d+$/.test(primary.value)) noteParts.push(primary.value);
  // Staff sometimes mark more than one reason. The lead keeps the first as its
  // code; the rest are written into the note rather than dropped.
  const seen = new Set<ReasonCode>(primary ? [primary.code] : []);
  for (const r of more) {
    if (seen.has(r.code)) continue;
    seen.add(r.code);
    const text = r.code === 'J' && !/^\d+$/.test(r.value) ? `: ${r.value}` : '';
    noteParts.push(`Also: ${r.code} (${REASON_CODE_LABELS[r.code]})${text}`);
  }
  const note = noteParts.length ? noteParts.join('; ') : null;
  return {
    slot: `Tel${p.num}`,
    date: header.date,
    follower: header.follower,
    page: header.page,
    customer_name: p.name,
    customer_phone: p.customerPhone,
    reason_code: primary?.code ?? null,
    note,
    promise_date: null,
    source_fragment: p.sourceFragments.filter(Boolean).join('\n\n').slice(0, 500),
    warnings: p.warnings,
    include: true
  };
}

function parseDatingSection(
  text: string,
  datingStart: number
): Array<{
  phone: string | null;
  appointmentTime: string | null;
  appointmentDate: string | null;
  firstContactBucket: string | null;
  source_fragment: string;
}> {
  if (datingStart >= text.length) return [];
  const section = text.slice(datingStart);

  const entries: Array<{
    phone: string | null;
    appointmentTime: string | null;
    appointmentDate: string | null;
    firstContactBucket: string | null;
    source_fragment: string;
  }> = [];

  const entryRegex = /(^|\n)\s*(\d+)\s*\/\s*លេខទូរស័ព្[^\n]*/g;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = entryRegex.exec(section)) !== null) {
    starts.push(m.index + (m[1] ? m[1].length : 0));
  }

  for (let i = 0; i < starts.length; i++) {
    const endIdx = i + 1 < starts.length ? starts[i + 1] : section.length;
    const body = section.slice(starts[i], endIdx);
    const firstLine = body.split('\n')[0] || '';

    const phoneMatch = firstLine.match(/=\s*([\d+\-\s()\/]+)/);
    const rawPhone = phoneMatch ? phoneMatch[1].trim() : '';
    const phone: string | null = rawPhone ? normalizePhoneSegment(rawPhone) : null;

    let appointmentTime: string | null = null;
    let appointmentDate: string | null = null;
    const apptLineMatch = body.match(/ថ្ងៃ[^\n]*?ម៉ោង\s*=?\s*([^\n]+)/);
    if (apptLineMatch) {
      const apptRaw = apptLineMatch[1].trim();
      const timeM = apptRaw.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM))/);
      if (timeM) appointmentTime = timeM[1];
      const dateP = parseDdMmYy(apptRaw);
      if (dateP) appointmentDate = dateP;
    }

    let firstContactBucket: string | null = null;
    const buckets: Array<[RegExp, string]> = [
      [/1\s*-\s*3\s*day\s*=\s*(-?\d+)?/i, '1-3day'],
      [/4\s*-\s*7\s*day\s*=\s*(-?\d+)?/i, '4-7day'],
      [/8\s*-\s*15\s*day\s*=\s*(-?\d+)?/i, '8-15day'],
      [/16\s*-\s*31\s*day\s*=\s*(-?\d+)?/i, '16-31day'],
      [/1\s*-\s*3\s*month\s*=\s*(-?\d+)?/i, '1-3month'],
      [/3\s*-\s*6\s*month\s*=\s*(-?\d+)?/i, '3-6month'],
      [/6\s*-\s*12\s*month\s*=\s*(-?\d+)?/i, '6-12month'],
      [/Over\s*12\s*month\s*=\s*(-?\d+)?/i, 'over-12month']
    ];
    for (const [re, label] of buckets) {
      const bm = body.match(re);
      if (bm && bm[1] && bm[1].trim() !== '' && bm[1].trim() !== '0') {
        firstContactBucket = label;
        break;
      }
    }

    if (!phone && !appointmentTime && !appointmentDate && !firstContactBucket) {
      continue;
    }

    entries.push({
      phone,
      appointmentTime,
      appointmentDate,
      firstContactBucket,
      source_fragment: body.trim().slice(0, 500)
    });
  }

  return entries;
}

/**
 * Field starts in the daily report. Each must begin right after whitespace,
 * and a match puts it back on a line of its own.
 */
const FIELD_START = [
  // section markers: 💞Follow up, #របាយការណ៍, 🚩Page, 👉, ☎️9.Phone, /🥰10 .Dating
  '\\/?(?:💞|🚩|👉|☎|🥰)', '#(?=\\S)',
  // the follower's name, standing just before 🚩Page
  '[A-Za-z][A-Za-z0-9 _.-]{0,30}?[ \\t]+🚩',
  // Tel slots: Tel1=, Tel 2=, T3=,0, Tel=0889..., T el 0889...
  'T[ \\t]*(?:e[ \\t]*l?)?[ \\t]*\\d{0,2}[ \\t]*(?:=|[ \\t]+[+\\d])',
  'Nam(?:e)?[ \\t]*=', 'Name\\b', 'Pv[ \\t]*=', 'comment\\b',
  // a-j items: a.ថ្លៃពេក, c ខ្ញុំ..., a.Night(, c. Callin, d Group=
  '[a-jA-J](?:\\.[ \\t]?|[ \\t])?[\\u1780-\\u17FF]', '[a-jA-J]\\.[ \\t]?[A-Za-z]', '[a-fA-F][ \\t][A-Z][a-z]+[ \\t]*=',
  // numbered items: 1.Messege, 3..Fack, 2.ភ្ញៀវ; 1/Connected, 1/លេខ, 1/1-3day (not dates)
  '\\d{1,2}\\.+[^\\d\\s]', '\\d{1,2}\\/(?:[A-Za-z\\u1780-\\u17FF]|\\d{1,2}-\\d)',
].join('|');

/**
 * A report copied back out of Telegram often loses its line breaks, so the
 * fields arrive run together on a few long lines. Put each field back on its
 * own line. Leading indentation is left alone, so a report that still has its
 * line breaks comes out unchanged.
 */
export function unflattenReport(text: string): string {
  return text.replace(new RegExp(`(\\S)[ \\t]+(?=${FIELD_START})`, 'gu'), '$1\n');
}

export function parseBulkReport(text: string): BulkReportParseResult {
  const warnings: string[] = [];
  const original = text.replace(/\r\n/g, '\n');
  const normalized = unflattenReport(original);
  const lines = normalized.split('\n');

  let dateLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/ថ្ងៃទី|របាយការណ៍/.test(lines[i]) && parseDdMmYy(lines[i])) {
      dateLineIndex = i;
      break;
    }
  }
  const headerDate = extractDate(lines, warnings);
  const follower = extractFollower(lines, dateLineIndex >= 0 ? dateLineIndex : 0);
  const page = extractPage(lines);
  const header: BulkReportHeader = { date: headerDate, follower, page };

  const bounds = findSectionBounds(normalized);
  const counters = extractCounters(normalized.slice(0, bounds.datingStart));

  const reasonList = findReasonList(normalized, bounds.datingStart);
  const slotRegion = normalized.slice(0, reasonList ? reasonList.start : bounds.datingStart);
  const partials = extractTelBlocks(slotRegion).map(b => parseTelBlockPartial(b, !reasonList));
  const merged = mergeSlotPartials(partials);
  if (reasonList) applyReasonList(merged, normalized.slice(reasonList.end, bounds.datingStart));
  const drafts: LeadEventDraft[] = [];
  let emptySlots = 0;
  const totalTelSlotsExpected = 10;

  const slotNums = Array.from(merged.keys()).sort((a, b) => a - b);
  for (const num of slotNums) {
    const draft = slotPartialToDraft(merged.get(num)!, header);
    if (draft) drafts.push(draft);
    else emptySlots++;
  }
  for (let n = 1; n <= totalTelSlotsExpected; n++) {
    if (!merged.has(n)) emptySlots++;
  }

  const datingEntries = parseDatingSection(normalized, bounds.datingStart);
  let datingIdx = 0;
  for (const entry of datingEntries) {
    datingIdx++;
    const noteAdditions: string[] = [];
    if (entry.appointmentTime) noteAdditions.push(`Appointment time: ${entry.appointmentTime}`);
    if (entry.firstContactBucket) noteAdditions.push(`First-contact: ${entry.firstContactBucket}`);
    const datingNote = noteAdditions.join('; ');

    // A Dating entry binds to an existing Tel draft only if that draft has no
    // promise_date yet. A second Dating entry for the same phone represents a
    // distinct visit (different day/time) and must NOT overwrite the first —
    // emit it as its own `dating-N` draft so both appointments survive.
    const siblings = entry.phone ? drafts.filter(d => d.customer_phone === entry.phone) : [];
    const target = siblings.find(d => !d.promise_date) || null;

    if (target) {
      if (entry.appointmentDate) target.promise_date = entry.appointmentDate;
      if (datingNote) {
        target.note = target.note ? `${target.note}; ${datingNote}` : datingNote;
      }
    } else if (entry.phone) {
      const sibling = siblings[0];
      drafts.push({
        slot: `dating-${datingIdx}`,
        date: header.date,
        follower: header.follower,
        page: header.page,
        customer_name: sibling?.customer_name ?? null,
        customer_phone: entry.phone,
        reason_code: null,
        note: datingNote || null,
        promise_date: entry.appointmentDate,
        source_fragment: entry.source_fragment,
        warnings: [],
        include: true
      });
    }
  }

  const summary: BulkReportSummary = {
    counters,
    raw_text: original
  };

  return {
    header,
    summary,
    drafts,
    warnings,
    empty_slots: emptySlots
  };
}

export const REASON_CODE_INFO = {
  codes: REASON_CODES,
  labels: REASON_CODE_LABELS,
  isReasonCode
};
