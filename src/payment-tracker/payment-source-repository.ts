/**
 * The only place audit-sales reads ar_tracker.ar_state.
 *
 * The collection belongs to another system. This module therefore exposes a
 * deliberately tiny surface — three projected reads and nothing else. There is
 * no insert, update, delete, or index method here, and PaymentReadCollection
 * has exactly one member, so a caller holding this repository cannot write to
 * the source even by accident.
 *
 * The projection is a shared constant rather than a per-call literal so every
 * read returns the same fields, and the collection contract pins the projection
 * type to that constant: passing a wider projection does not compile.
 */
import { RawPaymentAr } from './payment-types';
import { cambodiaStartOfDate } from './payment-domain';

/** Exactly the fields the domain layer validates. _id is explicitly excluded. */
export const PAYMENT_AR_PROJECTION = {
  _id: 0,
  ar_id: 1,
  home_id: 1,
  customer_name: 1,
  customer_phone: 1,
  current_status: 1,
  amount: 1,
  credit_applied: 1,
  due_date: 1,
} as const;

export interface PaymentFindCursor {
  toArray(): Promise<RawPaymentAr[]>;
}

/**
 * Read-only view of ar_state. One method, by design — this is the type that
 * makes "audit-sales never writes to the source" a compile-time property
 * rather than a code-review promise.
 */
export interface PaymentReadCollection {
  find(
    filter: Record<string, unknown>,
    options: { projection: typeof PAYMENT_AR_PROJECTION }
  ): PaymentFindCursor;
}

/** Source statuses eligible for a reminder. Mirrors the domain rule. */
const ELIGIBLE_STATUSES = ['PENDING', 'OVERDUE'];

export class PaymentSourceRepository {
  constructor(private readonly col: PaymentReadCollection) {}

  /**
   * The daily scan query. Filters on current_status and a BSON Date ceiling so
   * the existing { current_status: 1, due_date: 1 } source index can serve it;
   * phone presence is a cheap pre-filter, but "first VALID phone" cannot be
   * expressed in the index and is finished in the domain layer.
   */
  async findCandidates(cutoff: Date): Promise<RawPaymentAr[]> {
    return this.col
      .find(
        {
          current_status: { $in: ELIGIBLE_STATUSES },
          due_date: { $lte: cutoff },
          'customer_phone.0': { $exists: true },
        },
        { projection: PAYMENT_AR_PROJECTION }
      )
      .toArray();
  }

  /**
   * Claim-time reread of the receivables a proposal already references.
   *
   * Deliberately unfiltered by status: a proposal whose AR is now PAID must
   * come back as PAID so it can be cancelled. Filtering by eligible status here
   * would make a paid receivable indistinguishable from a deleted one, and the
   * safe response to those two differs.
   */
  async findByArIds(arIds: string[]): Promise<RawPaymentAr[]> {
    const sorted = [...arIds].sort();
    return this.col
      .find({ ar_id: { $in: sorted } }, { projection: PAYMENT_AR_PROJECTION })
      .toArray();
  }

  /**
   * Every eligible receivable due on one exact Cambodia-local date. Used at
   * claim time to detect ARs that joined or left the phone-and-date group after
   * the draft was written. Bounds are UTC instants of local midnight, so a
   * receivable is never mis-bucketed by reading UTC calendar components.
   */
  async findCandidatesForDate(localDate: string): Promise<RawPaymentAr[]> {
    const start = cambodiaStartOfDate(localDate);
    const end = cambodiaStartOfDate(nextLocalDate(localDate));
    return this.col
      .find(
        {
          current_status: { $in: ELIGIBLE_STATUSES },
          due_date: { $gte: start, $lt: end },
          'customer_phone.0': { $exists: true },
        },
        { projection: PAYMENT_AR_PROJECTION }
      )
      .toArray();
  }
}

function nextLocalDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}
