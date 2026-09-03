/**
 * Array-backed stand-in for the read-only ar_state collection.
 *
 * Records the exact filter and projection the repository built so tests can
 * assert on the query itself, not just its results. That matters more than
 * usual here: the query IS the safety boundary — a widened projection or a
 * dropped status filter would leak source fields or draft reminders for
 * receivables that are not due.
 */
import { RawPaymentAr } from '../../src/payment-tracker/payment-types';
import { PaymentFindCursor, PaymentReadCollection } from '../../src/payment-tracker/payment-source-repository';

export class RecordingPaymentCollection implements PaymentReadCollection {
  lastFilter: Record<string, unknown> = {};
  lastProjection: Record<string, 0 | 1> = {};

  constructor(private readonly rows: RawPaymentAr[]) {}

  find(filter: Record<string, unknown>, options: { projection: Record<string, 0 | 1> }): PaymentFindCursor {
    this.lastFilter = filter;
    this.lastProjection = options.projection;
    const rows = this.rows;
    return { toArray: async () => rows };
  }
}
