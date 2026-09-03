/**
 * Payment Tracker source and domain shapes.
 *
 * RawPaymentAr mirrors one `ar_tracker.ar_state` document as it actually
 * arrives: every field is `unknown` because the source is owned by another
 * system and audit-sales never writes to it, so nothing about its shape can be
 * assumed. Validation narrows Raw -> Validated; anything that does not narrow
 * cleanly is dropped rather than repaired (see payment-domain).
 */

/** One receivable exactly as projected out of ar_tracker.ar_state. */
export interface RawPaymentAr {
  ar_id?: unknown;
  home_id?: unknown;
  customer_name?: unknown;
  customer_phone?: unknown;
  current_status?: unknown;
  amount?: unknown;
  credit_applied?: unknown;
  due_date?: unknown;
}

/** The only two source statuses a reminder may ever be drafted from. */
export type PaymentArStatus = 'PENDING' | 'OVERDUE';

/**
 * A receivable that passed every eligibility rule. Money is kept as the exact
 * numbers read from the source — never rounded or reformatted here, so the
 * fingerprint stays faithful to what was actually read.
 */
export interface ValidatedPaymentAr {
  arId: string;
  homeId: string | null;
  customerName: string | null;
  /** First entry of customer_phone that normalized to a valid Cambodian number. */
  primaryPhone: string;
  status: PaymentArStatus;
  amountValue: number;
  creditValue: number;
  amountDue: number;
  /** Uppercased. All ARs in a group must agree. */
  currency: string;
  /** Exact Cambodia-local calendar date, YYYY-MM-DD. */
  dueDate: string;
  /** UTC instant of 00:00 on dueDate in Asia/Phnom_Penh. */
  sendNotBefore: Date;
  /** First 7 chars of dueDate. Reporting only — never used for selection. */
  billingMonth: string;
}

/**
 * One reminder's worth of receivables: everything sharing a normalized phone
 * and an exact local due date. One group produces at most one proposal.
 */
export interface PaymentGroup {
  primaryPhone: string;
  dueDate: string;
  billingMonth: string;
  currency: string;
  amountTotal: number;
  creditTotal: number;
  balanceDue: number;
  /** Lexicographically sorted; the canonical order for every list below. */
  arIds: string[];
  homeReferences: string[];
  customerNames: string[];
  ars: ValidatedPaymentAr[];
  sendNotBefore: Date;
}

export type PaymentValidationResult =
  | { ok: true; ar: ValidatedPaymentAr }
  | { ok: false; code: string; arId: string | null };

/** A group that failed closed. It produces no draft and is counted, not retried. */
export interface PaymentGroupingError {
  code: string;
  dedupeKey: string;
  arIds: string[];
}

export interface PaymentGroupingResult {
  groups: PaymentGroup[];
  errors: PaymentGroupingError[];
}
