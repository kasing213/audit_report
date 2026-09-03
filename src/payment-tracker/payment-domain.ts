/**
 * Pure Payment Tracker domain rules: Cambodia calendar boundaries, receivable
 * validation, grouping, deduplication, and source fingerprinting.
 *
 * Everything here fails closed. A receivable that is missing, malformed,
 * negative, currency-mismatched, or of an unrecognised status is dropped — it is
 * never estimated, defaulted, or repaired, because a wrong payment reminder is
 * worse than a missing one. No I/O lives in this module, which is what lets the
 * scanner and the claim-time verifier apply byte-identical rules.
 */
import { createHash } from 'crypto';
import { toInternationalPhone } from '../utils/phone-utils';
import { getTodayDate, toZonedDateTime } from '../utils/time';
import { PAYMENT_TRACKER_ORG } from '../outreach/orgs';
import {
  PaymentArStatus,
  PaymentGroup,
  PaymentGroupingError,
  PaymentGroupingResult,
  PaymentValidationResult,
  RawPaymentAr,
  ValidatedPaymentAr,
} from './payment-types';

export const CAMBODIA_TZ = 'Asia/Phnom_Penh';

/** The only source statuses that may produce a reminder. Everything else fails closed. */
const ELIGIBLE_STATUSES: readonly string[] = ['PENDING', 'OVERDUE'];

/**
 * Cambodian E.164 after normalization. toInternationalPhone() is total — it
 * happily returns '+855invalid' for junk — so this check is what actually
 * rejects a bad source phone, not belt-and-braces.
 */
const PHONE_E164 = /^\+855\d{8,9}$/;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Exact Cambodia-local calendar date (YYYY-MM-DD) for an instant. */
export function cambodiaDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CAMBODIA_TZ }).format(date);
}

/** UTC instant of 00:00 on a Cambodia-local calendar date. */
export function cambodiaStartOfDate(dateKey: string): Date {
  if (!DATE_KEY.test(dateKey)) throw new Error(`invalid Cambodia date key: ${dateKey}`);
  const start = toZonedDateTime(dateKey, '00:00', CAMBODIA_TZ);
  if (!start) throw new Error(`invalid Cambodia date key: ${dateKey}`);
  return start;
}

/**
 * The last instant of tomorrow, Cambodia time — the scan due-date ceiling.
 * Derived as (start of the day after tomorrow) minus 1ms so it needs no
 * assumption about day length.
 */
export function endOfTomorrowCambodia(now: Date): Date {
  const today = cambodiaDateKey(now);
  return new Date(cambodiaStartOfDate(addLocalDays(today, 2)).getTime() - 1);
}

/** Calendar-day arithmetic on a YYYY-MM-DD key, via UTC to dodge offset math. */
function addLocalDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Cambodia calendar date for right now. Thin wrapper so callers omit the tz. */
export function cambodiaToday(): string {
  return getTodayDate(CAMBODIA_TZ);
}

interface Money {
  value: number;
  currency: string;
}

/**
 * A source money field is valid only as { value: finite non-negative number,
 * currency: non-empty string }. Notably null is NOT zero — a missing credit
 * means the credit is unknown, so the receivable is ineligible rather than
 * billed in full.
 */
function readMoney(raw: unknown): Money | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { value?: unknown; currency?: unknown };
  const value = candidate.value;
  const currency = candidate.currency;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (typeof currency !== 'string' || currency.trim().length === 0) return null;
  return { value, currency: currency.trim().toUpperCase() };
}

function readNonEmptyString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

/** First customer_phone entry, in source order, that normalizes to a valid number. */
function selectPrimaryPhone(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim().length === 0) continue;
    const normalized = toInternationalPhone(entry.trim());
    if (PHONE_E164.test(normalized)) return normalized;
  }
  return null;
}

function readDueDate(raw: unknown): Date | null {
  if (!(raw instanceof Date)) return null;
  return Number.isNaN(raw.getTime()) ? null : raw;
}

function invalid(code: string, arId: string | null): PaymentValidationResult {
  return { ok: false, code, arId };
}

/**
 * Narrow one source document to a sendable receivable, or explain why not.
 * `cutoff` is the Cambodia end-of-tomorrow ceiling: anything due later is not
 * yet in scope.
 */
export function validatePaymentAr(raw: RawPaymentAr, cutoff: Date): PaymentValidationResult {
  const arId = readNonEmptyString(raw.ar_id);
  if (!arId) return invalid('invalid_ar_id', null);

  const status = readNonEmptyString(raw.current_status);
  if (!status || !ELIGIBLE_STATUSES.includes(status)) return invalid('ineligible_status', arId);

  const dueDate = readDueDate(raw.due_date);
  if (!dueDate) return invalid('invalid_due_date', arId);
  if (dueDate.getTime() > cutoff.getTime()) return invalid('due_date_out_of_window', arId);

  const primaryPhone = selectPrimaryPhone(raw.customer_phone);
  if (!primaryPhone) return invalid('no_valid_phone', arId);

  const amount = readMoney(raw.amount);
  if (!amount) return invalid('invalid_amount', arId);

  const credit = readMoney(raw.credit_applied);
  if (!credit) return invalid('invalid_credit', arId);

  if (amount.currency !== credit.currency) return invalid('currency_mismatch', arId);

  const amountDue = Math.max(0, amount.value - credit.value);
  if (!(amountDue > 0)) return invalid('no_positive_balance', arId);

  const dueDateKey = cambodiaDateKey(dueDate);

  return {
    ok: true,
    ar: {
      arId,
      homeId: readNonEmptyString(raw.home_id),
      customerName: readNonEmptyString(raw.customer_name),
      primaryPhone,
      status: status as PaymentArStatus,
      amountValue: amount.value,
      creditValue: credit.value,
      amountDue,
      currency: amount.currency,
      dueDate: dueDateKey,
      sendNotBefore: cambodiaStartOfDate(dueDateKey),
      billingMonth: dueDateKey.slice(0, 7),
    },
  };
}

/** The suppression/dedupe boundary: one reminder per phone per exact local due date. */
export function paymentDedupeKey(primaryPhone: string, dueDate: string): string {
  return `${PAYMENT_TRACKER_ORG}|${primaryPhone}|${dueDate}`;
}

function byArId(a: ValidatedPaymentAr, b: ValidatedPaymentAr): number {
  return a.arId < b.arId ? -1 : a.arId > b.arId ? 1 : 0;
}

/**
 * Collapse validated receivables into one group per (phone, exact due date).
 *
 * Every list on the group is ordered by ar_id, so two scans reading the same
 * receivables in different Mongo orders produce identical output. A group whose
 * members disagree on currency fails closed — no conversion is invented.
 */
export function groupPaymentArs(ars: ValidatedPaymentAr[]): PaymentGroupingResult {
  const buckets = new Map<string, ValidatedPaymentAr[]>();
  for (const ar of ars) {
    const key = paymentDedupeKey(ar.primaryPhone, ar.dueDate);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(ar);
    else buckets.set(key, [ar]);
  }

  const groups: PaymentGroup[] = [];
  const errors: PaymentGroupingError[] = [];

  for (const [dedupeKey, bucket] of buckets) {
    const sorted = [...bucket].sort(byArId);
    const arIds = sorted.map((ar) => ar.arId);

    if (new Set(sorted.map((ar) => ar.currency)).size > 1) {
      errors.push({ code: 'mixed_currency', dedupeKey, arIds });
      continue;
    }

    const first = sorted[0];
    groups.push({
      primaryPhone: first.primaryPhone,
      dueDate: first.dueDate,
      billingMonth: first.billingMonth,
      currency: first.currency,
      amountTotal: sorted.reduce((sum, ar) => sum + ar.amountValue, 0),
      creditTotal: sorted.reduce((sum, ar) => sum + ar.creditValue, 0),
      balanceDue: sorted.reduce((sum, ar) => sum + ar.amountDue, 0),
      arIds,
      homeReferences: dedupePreservingOrder(sorted.map((ar) => ar.homeId)),
      customerNames: dedupePreservingOrder(sorted.map((ar) => ar.customerName)),
      ars: sorted,
      sendNotBefore: first.sendNotBefore,
    });
  }

  groups.sort((a, b) => (a.arIds[0] < b.arIds[0] ? -1 : a.arIds[0] > b.arIds[0] ? 1 : 0));
  return { groups, errors };
}

/** Drop nulls and repeats while keeping ar_id order — no alphabetical re-sort. */
function dedupePreservingOrder(values: Array<string | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === null || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * SHA-256 over canonical JSON of the protected source fields.
 *
 * Field order is built explicitly as pairs rather than relying on object
 * literal key order, and entries are sorted by ar_id, so the hash answers
 * exactly one question: has anything this reminder was based on changed since
 * it was drafted? A changed hash at claim time forces re-approval or
 * cancellation rather than a send.
 */
export function paymentFingerprint(group: PaymentGroup): string {
  const entries = [...group.ars].sort(byArId).map((ar) => [
    ['ar_id', ar.arId],
    ['current_status', ar.status],
    ['normalized_primary_phone', ar.primaryPhone],
    ['amount_value', ar.amountValue],
    ['amount_currency', ar.currency],
    ['credit_value', ar.creditValue],
    ['credit_currency', ar.currency],
    ['due_date', ar.dueDate],
  ]);

  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
