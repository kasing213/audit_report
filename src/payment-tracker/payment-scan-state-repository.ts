/**
 * Persists Payment Tracker scan health for the dashboard and for operators.
 *
 * One document, `_id: 'payment_tracker'`, in `payment_tracker_scan_state`.
 * Deliberately holds counts, timestamps, and machine-readable error codes only:
 * no phone number, name, home id, ar_id, or driver message ever lands here,
 * because this is the one payment record the UI renders and logs verbatim.
 */
import { Collection } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { PaymentScanHealthPort, PaymentScanResult } from './payment-scanner';

const COLLECTION = 'payment_tracker_scan_state';
const DOC_ID = 'payment_tracker';

/** How many recent summaries to keep. Enough to see a trend, not a history. */
const MAX_SUMMARIES = 20;

export interface PaymentScanStateDocument {
  _id: 'payment_tracker';
  last_scan_at: Date | null;
  last_error_code: string | null;
  last_error_at: Date | null;
  summaries: PaymentScanResult[];
}

export function emptyScanState(): PaymentScanStateDocument {
  return {
    _id: DOC_ID,
    last_scan_at: null,
    last_error_code: null,
    last_error_at: null,
    summaries: [],
  };
}

/**
 * A mutable health record the scanner writes into during a run. Kept separate
 * from persistence so the scanner itself stays free of I/O and can be tested
 * without a database.
 */
export class PaymentScanHealth implements PaymentScanHealthPort {
  last_error_code: string | null = null;
  summaries: PaymentScanResult[] = [];

  constructor(previous?: PaymentScanStateDocument) {
    if (previous) {
      this.last_error_code = previous.last_error_code;
      this.summaries = [...previous.summaries];
    }
  }
}

export class PaymentScanStateRepository {
  private col: Collection<PaymentScanStateDocument>;

  constructor() {
    this.col = DatabaseConnection.getInstance()
      .getDb()
      .collection<PaymentScanStateDocument>(COLLECTION);
  }

  async get(): Promise<PaymentScanStateDocument> {
    return (await this.col.findOne({ _id: DOC_ID })) ?? emptyScanState();
  }

  /** Write back after a run, successful or not. Keeps only the recent tail. */
  async save(health: PaymentScanHealthPort, now: Date): Promise<void> {
    const summaries = health.summaries.slice(-MAX_SUMMARIES);
    // replaceOne's WithoutId<T> rejects an _id in the replacement; the filter
    // already pins it, and upsert copies it in.
    await this.col.replaceOne(
      { _id: DOC_ID },
      {
        last_scan_at: now,
        last_error_code: health.last_error_code,
        last_error_at: health.last_error_code ? now : null,
        summaries,
      },
      { upsert: true }
    );
  }
}
