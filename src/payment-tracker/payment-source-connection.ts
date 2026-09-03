/**
 * A MongoClient dedicated to the Payment Tracker source.
 *
 * Deliberately NOT the audit-sales DatabaseConnection singleton: the source
 * lives on a different credential with a different (much narrower) privilege
 * set, and sharing a client would mean one connection string could reach both
 * databases. This class reads PAYMENT_TRACKER_DATABASE_URL and nothing else,
 * and hard-codes the ar_tracker.ar_state namespace so a mistyped URI path
 * cannot silently redirect reads.
 *
 * collection() hands back a PaymentReadCollection — a one-method view — rather
 * than a Db or a Collection. Callers therefore cannot insert, update, delete,
 * or create an index on the source even if they try.
 */
import { Filter, MongoClient } from 'mongodb';
import { Logger } from '../utils/logger';
import { RawPaymentAr } from './payment-types';
import { PAYMENT_AR_PROJECTION, PaymentReadCollection } from './payment-source-repository';
import {
  PaymentInspectionPort,
  SOURCE_COLLECTION,
  SOURCE_DB,
} from './payment-source-inspection';

const CONNECT_TIMEOUT_MS = 10_000;

export class PaymentSourceConnection {
  private client: MongoClient | null = null;

  /** True once connect() has succeeded — lets shutdown skip an unused client. */
  isConnected(): boolean {
    return this.client !== null;
  }

  async connect(): Promise<void> {
    if (this.client) return;

    const uri = process.env.PAYMENT_TRACKER_DATABASE_URL;
    if (!uri) throw new Error('PAYMENT_TRACKER_DATABASE_URL is not set');

    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
    });
    await client.connect();
    this.client = client;
    Logger.info(`Payment Tracker source connected (${SOURCE_DB}.${SOURCE_COLLECTION}, read-only)`);
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    await client.close();
  }

  /** The narrow read view. Throws rather than lazily connecting, so a caller
   * can never issue a source read on an unverified connection. */
  collection(): PaymentReadCollection {
    const col = this.requireClient().db(SOURCE_DB).collection<RawPaymentAr>(SOURCE_COLLECTION);
    return {
      find: (filter, options) =>
        col.find(filter as Filter<RawPaymentAr>, { projection: options.projection }),
    };
  }

  /**
   * Richer read surface for the pre-rollout inspection command only. Still
   * read-only: runCommand is used exclusively for connectionStatus, and the
   * query helpers mirror the production candidate filter.
   */
  inspectionPort(): PaymentInspectionPort {
    const db = this.requireClient().db(SOURCE_DB);
    const col = db.collection<RawPaymentAr>(SOURCE_COLLECTION);
    const candidateFilter = (cutoff: Date): Filter<RawPaymentAr> =>
      ({
        current_status: { $in: ['PENDING', 'OVERDUE'] },
        due_date: { $lte: cutoff },
        'customer_phone.0': { $exists: true },
      }) as Filter<RawPaymentAr>;

    return {
      command: (spec) => db.command(spec) as Promise<Record<string, unknown>>,
      listIndexes: () => col.listIndexes().toArray() as Promise<Array<Record<string, unknown>>>,
      explainCandidates: (cutoff) =>
        col
          .find(candidateFilter(cutoff), { projection: PAYMENT_AR_PROJECTION })
          .explain('executionStats') as Promise<Record<string, unknown>>,
      countCandidates: (cutoff) => col.countDocuments(candidateFilter(cutoff)),
      countMissingPhone: (cutoff) =>
        col.countDocuments({
          current_status: { $in: ['PENDING', 'OVERDUE'] },
          due_date: { $lte: cutoff },
          'customer_phone.0': { $exists: false },
        } as Filter<RawPaymentAr>),
      countMissingCredit: (cutoff) =>
        col.countDocuments({
          current_status: { $in: ['PENDING', 'OVERDUE'] },
          due_date: { $lte: cutoff },
          credit_applied: null,
        } as Filter<RawPaymentAr>),
    };
  }

  private requireClient(): MongoClient {
    if (!this.client) {
      throw new Error('Payment Tracker source not connected. Call connect() first.');
    }
    return this.client;
  }
}
