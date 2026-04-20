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
  for (const line of lines) {
    const match = line.match(/^[\s\d.a-jA-J)\/]*([A-Za-z][^=]*?)\s*=\s*(\d+)\s*$/);
    if (!match) continue;
    const rawLabel = match[1];
    const latinOnly = rawLabel.match(/^([A-Za-z][A-Za-z0-9 _\/]*)/);
    if (!latinOnly) continue;
    const key = normalizeKey(latinOnly[1]);
    const val = parseInt(match[2], 10);
    if (!key || !Number.isFinite(val)) continue;
    if (key === 'tel' || /^tel\d*$/.test(key)) continue;
    counters[key] = val;
  }
  return counters;
}

function findSectionBounds(text: string): { headerEnd: number; telStart: number; datingStart: number } {
  const telMatch = text.match(/\n\s*(?:☎️\s*)?\d*\.?\s*Phone\s*[（(]/i) || text.match(/\n\s*Tel\s*\d*\s*=/i);
  const telStart = telMatch ? telMatch.index ?? text.length : text.length;

  const datingRegex = /Dating visit|សន្យាមកមើល/;
  const datingMatch = datingRegex.exec(text);
  let datingStart = datingMatch ? datingMatch.index : text.length;
  if (datingStart > 0) {
    const lineStart = text.lastIndexOf('\n', datingStart);
    if (lineStart >= 0) datingStart = lineStart;
  }

  return { headerEnd: telStart, telStart, datingStart };
}

function extractTelBlocks(text: string, datingStart: number): Array<{ num: number; body: string; raw: string }> {
  const blocks: Array<{ num: number; body: string; raw: string }> = [];
  const regionEnd = Math.min(text.length, datingStart);
  const region = text.slice(0, regionEnd);

  const telRegex = /(^|\n)\s*(?:[☎️☎]\s*)?T\s*el?\s*(\d{1,2})\s*=\s*([^\n]*)/gi;
  const starts: Array<{ num: number; index: number; firstLine: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = telRegex.exec(region)) !== null) {
    const num = parseInt(m[2], 10);
    if (!Number.isFinite(num) || num < 1 || num > 20) continue;
    const startIdx = m.index + m[1].length;
    starts.push({ num, index: startIdx, firstLine: m[3] });
  }

  for (let i = 0; i < starts.length; i++) {
    const startIdx = starts[i].index;
    const endIdx = i + 1 < starts.length ? starts[i + 1].index : regionEnd;
    const raw = region.slice(startIdx, endIdx);
    blocks.push({ num: starts[i].num, body: raw, raw });
  }
  return blocks;
}

function parseTelBlock(
  num: number,
  body: string,
  header: BulkReportHeader
): LeadEventDraft | null {
  const warnings: string[] = [];
  const lines = body.split('\n');
  const firstLine = lines[0] || '';

  const phoneMatch = firstLine.match(/=\s*([\d+\-\s()]+)/);
  const rawPhone = phoneMatch ? phoneMatch[1].trim() : '';
  if (!isPhoneCandidate(rawPhone)) {
    return null;
  }

  let customerPhone: string | null = null;
  try {
    customerPhone = toInternationalPhone(cleanPhoneDigits(rawPhone));
  } catch {
    warnings.push('Phone normalization failed');
  }

  let customerName: string | null = null;
  const nameMatch = body.match(/\bName\s*=\s*([^\n]+)/i);
  if (nameMatch) {
    const v = nameMatch[1].trim();
    if (v) customerName = v;
  }

  let province: string | null = null;
  const pvMatch = body.match(/\bPv\s*=\s*([^\n]+)/i);
  if (pvMatch) {
    const v = pvMatch[1].trim();
    if (v) province = v;
  }

  let reasonCode: ReasonCode | null = null;
  let reasonFreeText: string | null = null;
  const reasonLetterRegex = /^\s*([a-jA-J])\s*[\.\)]?\s*(.*?)\s*=\s*(.*)$/gm;
  let rm: RegExpExecArray | null;
  while ((rm = reasonLetterRegex.exec(body)) !== null) {
    const letter = rm[1].toLowerCase();
    const value = rm[3].trim();
    if (!value || value === '0') continue;
    const code = REASON_LETTER_TO_CODE[letter];
    if (!code) continue;
    if (reasonCode === null) {
      reasonCode = code;
      if (code === 'J' && value && !/^\d+$/.test(value)) {
        reasonFreeText = value;
      }
    }
  }

  const noteParts: string[] = [];
  if (province) noteParts.push(`Province: ${province}`);
  if (reasonFreeText) noteParts.push(reasonFreeText);
  const note = noteParts.length ? noteParts.join('; ') : null;

  return {
    slot: `Tel${num}`,
    date: header.date,
    follower: header.follower,
    page: header.page,
    customer_name: customerName,
    customer_phone: customerPhone,
    reason_code: reasonCode,
    note,
    promise_date: null,
    source_fragment: body.trim().slice(0, 500),
    warnings,
    include: customerPhone !== null
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

    const phoneMatch = firstLine.match(/=\s*([\d+\-\s()]+)/);
    const rawPhone = phoneMatch ? phoneMatch[1].trim() : '';
    let phone: string | null = null;
    if (isPhoneCandidate(rawPhone)) {
      phone = toInternationalPhone(cleanPhoneDigits(rawPhone));
    }

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

export function parseBulkReport(text: string): BulkReportParseResult {
  const warnings: string[] = [];
  const normalized = text.replace(/\r\n/g, '\n');
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
  const headerSection = normalized.slice(0, bounds.telStart);
  const counters = extractCounters(headerSection);

  const telBlocks = extractTelBlocks(normalized, bounds.datingStart);
  const seenNums = new Set<number>();
  const drafts: LeadEventDraft[] = [];
  let emptySlots = 0;
  const totalTelSlotsExpected = 10;

  for (const block of telBlocks) {
    if (seenNums.has(block.num)) continue;
    seenNums.add(block.num);
    const draft = parseTelBlock(block.num, block.body, header);
    if (draft) {
      drafts.push(draft);
    } else {
      emptySlots++;
    }
  }
  for (let n = 1; n <= totalTelSlotsExpected; n++) {
    if (!seenNums.has(n)) emptySlots++;
  }

  const datingEntries = parseDatingSection(normalized, bounds.datingStart);
  let datingIdx = 0;
  for (const entry of datingEntries) {
    datingIdx++;
    const existing = entry.phone ? drafts.find(d => d.customer_phone === entry.phone) : null;
    const noteAdditions: string[] = [];
    if (entry.appointmentTime) noteAdditions.push(`Appointment time: ${entry.appointmentTime}`);
    if (entry.firstContactBucket) noteAdditions.push(`First-contact: ${entry.firstContactBucket}`);
    const datingNote = noteAdditions.join('; ');

    if (existing) {
      if (entry.appointmentDate) existing.promise_date = entry.appointmentDate;
      if (datingNote) {
        existing.note = existing.note ? `${existing.note}; ${datingNote}` : datingNote;
      }
    } else if (entry.phone) {
      drafts.push({
        slot: `dating-${datingIdx}`,
        date: header.date,
        follower: header.follower,
        page: header.page,
        customer_name: null,
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
    raw_text: normalized
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
