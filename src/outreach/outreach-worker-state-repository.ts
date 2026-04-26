import { Collection } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { Logger } from '../utils/logger';

const COLLECTION = 'outreach_worker_state';
const SINGLETON_ID = 'singleton';

export interface WorkerStateDocument {
  _id: string;
  paused: boolean;
  last_heartbeat_at: Date | null;
  worker_id: string | null;
  sent_today: number;
  claims_today: number;
  claims_today_day: string | null;
  last_error: string | null;
  updated_at: Date;
}

const DEFAULT_STATE: WorkerStateDocument = {
  _id: SINGLETON_ID,
  paused: false,
  last_heartbeat_at: null,
  worker_id: null,
  sent_today: 0,
  claims_today: 0,
  claims_today_day: null,
  last_error: null,
  updated_at: new Date(0),
};

function utcDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

let indexesReady = false;

export class OutreachWorkerStateRepository {
  private col: Collection<WorkerStateDocument>;

  constructor() {
    const db = DatabaseConnection.getInstance().getDb();
    this.col = db.collection<WorkerStateDocument>(COLLECTION);
    if (!indexesReady) {
      indexesReady = true;
    }
  }

  async getStatus(): Promise<WorkerStateDocument> {
    const doc = await this.col.findOne({ _id: SINGLETON_ID });
    if (!doc) return { ...DEFAULT_STATE };
    return doc;
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.col.updateOne(
      { _id: SINGLETON_ID },
      { $set: { paused, updated_at: new Date() }, $setOnInsert: { ...DEFAULT_STATE, paused } },
      { upsert: true }
    );
  }

  async setHeartbeat(input: {
    worker_id: string;
    sent_today: number;
    last_error: string | null;
  }): Promise<void> {
    const now = new Date();
    await this.col.updateOne(
      { _id: SINGLETON_ID },
      {
        $set: {
          last_heartbeat_at: now,
          worker_id: input.worker_id,
          sent_today: input.sent_today,
          last_error: input.last_error,
          updated_at: now,
        },
        $setOnInsert: {
          _id: SINGLETON_ID,
          paused: false,
          claims_today: 0,
          claims_today_day: null,
        },
      },
      { upsert: true }
    );
  }

  async setLastError(message: string): Promise<void> {
    await this.col.updateOne(
      { _id: SINGLETON_ID },
      { $set: { last_error: message, updated_at: new Date() }, $setOnInsert: { ...DEFAULT_STATE, last_error: message } },
      { upsert: true }
    );
  }

  /**
   * Atomically increment claims_today, rolling over at UTC midnight.
   * Returns the post-increment count, or null if cap would be exceeded.
   */
  async tryReserveClaim(dailyCap: number): Promise<number | null> {
    const today = utcDayKey();
    // Reset the counter when the day rolls.
    await this.col.updateOne(
      { _id: SINGLETON_ID, claims_today_day: { $ne: today } },
      { $set: { claims_today: 0, claims_today_day: today, updated_at: new Date() }, $setOnInsert: { ...DEFAULT_STATE, claims_today_day: today } },
      { upsert: true }
    );

    const result = await this.col.findOneAndUpdate(
      { _id: SINGLETON_ID, claims_today: { $lt: dailyCap } },
      { $inc: { claims_today: 1 }, $set: { updated_at: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) {
      return null;
    }
    return result.claims_today;
  }

  async releaseClaim(): Promise<void> {
    try {
      await this.col.updateOne(
        { _id: SINGLETON_ID, claims_today: { $gt: 0 } },
        { $inc: { claims_today: -1 }, $set: { updated_at: new Date() } }
      );
    } catch (err) {
      Logger.warn(`worker-state releaseClaim failed: ${(err as Error).message}`);
    }
  }
}
