/**
 * Pure spreadsheet-parsing logic for the `/api/import` route (crm-routes.ts).
 *
 * Deliberately dependency-free (no Mongo, no Express, no repositories) so it can
 * be unit-checked directly against a real .xlsx without touching a database —
 * see scripts/check-import-aliases.js. Cross-row DB concerns (already_in_db,
 * in_cooldown) are I/O, so the route fetches those exclusion sets and passes
 * them in rather than this module querying anything itself.
 */
import ExcelJS from 'exceljs';
import { toInternationalPhone } from '../utils/phone-utils';

// Header names that identify a phone column. The supplied QuickBook exports use
// 'Phone Number'; earlier CSVs used a bare 'phone'. Matching only 'phone' sent
// aliased files down the free-text QuickBook parser, which mangled them.
export const PHONE_HEADER_ALIASES = ['phone', 'phone number', 'phone_number', 'phone no', 'tel', 'number', 'contact'];
export const INDEX_HEADER_ALIASES = ['no', 'no.', '#', 'index'];
export const PHONE_E164 = /^\+855\d{8,9}$/;

export interface ImportBuckets {
  parsed: number;
  invalid_format: number;
  duplicate_in_file: number;
  already_in_db: number;
  in_cooldown: number;
  net_new: number;
}

export interface ParsePhoneSheetOptions {
  /** Date (YYYY-MM-DD) rows without their own date get backdated to. */
  staleDateStr: string;
  /** Phones (E.164) already present in the DB for this workspace. */
  existingPhones?: Set<string>;
  /** Phones (E.164) currently suppressed/in-cooldown for this workspace. */
  suppressedPhones?: Set<string>;
}

export interface ParsePhoneSheetResult {
  rows: any[];
  buckets: ImportBuckets;
  headers: string[];
  usedFallback: boolean;
}

function emptyBuckets(): ImportBuckets {
  return { parsed: 0, invalid_format: 0, duplicate_in_file: 0, already_in_db: 0, in_cooldown: 0, net_new: 0 };
}

/** Lower-cased, trimmed header row (index 0 === column A). Pure — no I/O. */
export function readHeaders(worksheet: ExcelJS.Worksheet): string[] {
  const headerRow = worksheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell((cell, colNumber) => {
    headers[colNumber - 1] = String(cell.value || '').toLowerCase().trim();
  });
  return headers;
}

/** True if any header matches a known phone-column alias. */
export function hasPhoneColumn(headers: string[]): boolean {
  return headers.findIndex((h) => PHONE_HEADER_ALIASES.includes(h)) >= 0;
}

// Parse one QuickBook report line: "060-Pkarikkongsuon 092 462911"
// → { name: "Pkarikkongsuon", phone: "+85592462911" }. Returns null if no phone → reject row.
export function extractQuickBookRecord(text: string): { name: string | null; phone: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // strip leading sequence id like "060-" or "6." (1-3 digits + separator)
  const idMatch = trimmed.match(/^\s*\d{1,3}\s*[-.]\s*/);
  const body = idMatch ? trimmed.slice(idMatch[0].length) : trimmed;
  // find first digit run that is a Cambodian phone (8-11 digits, spaces/dots/dashes allowed)
  for (const m of body.matchAll(/\d[\d\s.\-]{5,}\d/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 11) {
      const name = body.slice(0, m.index).trim();
      return { name: name || null, phone: toInternationalPhone(digits) };
    }
  }
  return null; // no number in the row → reject
}

/**
 * Parse a worksheet into import rows + buckets.
 *
 * If a recognised phone-column header is present, parses it structurally:
 * header-alias detection, index-column skipping, phone normalisation/validation,
 * and in-file dedup, cross-checked against the caller-supplied existing/suppressed
 * sets. Otherwise falls back to the header-less QuickBook free-text parser
 * (`extractQuickBookRecord`), unchanged from its original behavior.
 */
export function parsePhoneSheet(worksheet: ExcelJS.Worksheet, opts: ParsePhoneSheetOptions): ParsePhoneSheetResult {
  const existingPhones = opts.existingPhones ?? new Set<string>();
  const suppressedPhones = opts.suppressedPhones ?? new Set<string>();
  const buckets = emptyBuckets();
  const rows: any[] = [];

  const headers = readHeaders(worksheet);
  const phoneColIndex = headers.findIndex((h) => PHONE_HEADER_ALIASES.includes(h));

  if (phoneColIndex >= 0) {
    // Structured sheet: one phone per row under a recognised header. The index
    // column ('No.') is deliberately ignored rather than imported as data.
    const seenInFile = new Set<string>();

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // skip header
      const record: any = {};
      row.eachCell((cell, colNumber) => {
        const header = headers[colNumber - 1];
        if (!header || INDEX_HEADER_ALIASES.includes(header)) return;
        const value = cell.value !== null && cell.value !== undefined ? String(cell.value).trim() : null;
        if (PHONE_HEADER_ALIASES.includes(header)) record.phone = value;
        else record[header] = value;
      });
      if (!record.phone) return;

      buckets.parsed++;
      const intl = toInternationalPhone(String(record.phone).trim());
      if (!PHONE_E164.test(intl)) {
        buckets.invalid_format++;
        return;
      }
      if (seenInFile.has(intl)) {
        buckets.duplicate_in_file++;
        return;
      }
      seenInFile.add(intl);
      if (existingPhones.has(intl)) {
        buckets.already_in_db++;
        return;
      }
      if (suppressedPhones.has(intl)) {
        buckets.in_cooldown++;
        return;
      }

      buckets.net_new++;
      rows.push({ ...record, phone: intl, date: record.date || opts.staleDateStr });
    });

    return { rows, buckets, headers: ['name', 'phone', 'date'], usedFallback: false };
  }

  // QuickBook report export: no header, "ID-Name Phone" jammed into one text column.
  // Extract name + phone from each row's text; reject rows with no phone number.
  //
  // These are old leads (years old at export) with no real dates in the file. Backdate
  // them to the outreach stale threshold (45 days) so they immediately count as stale
  // and get staged into the outreach pipeline instead of looking brand-new.
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip potential header/title row
    const parts: string[] = [];
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.value !== null && cell.value !== undefined) parts.push(String(cell.value).trim());
    });
    const record = extractQuickBookRecord(parts.join(' '));
    if (record) {
      buckets.parsed++;
      buckets.net_new++;
      rows.push({ ...record, date: opts.staleDateStr });
    }
  });

  return { rows, buckets, headers: ['name', 'phone', 'date'], usedFallback: true };
}
