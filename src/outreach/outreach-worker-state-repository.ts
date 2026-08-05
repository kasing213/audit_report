import { Collection } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { Logger } from '../utils/logger';
import { OrgId, DEFAULT_ORG } from './orgs';

const COLLECTION = 'outreach_worker_state';

export interface WorkerStateDocument {
  // Per-org id: 'company' | 'personal'. Each org has its own worker state so the
  // daily caps, heartbeat, and pause flag are independent per sending number.
  // (Was a single _id:'singleton' doc before multi-org; migrated by
  // scripts/backfill-org-company.js.)
  _id: string;
  paused: boolean;
  // Manual (false) vs Auto (true) approval for this workspace's 9AM scan.
  // Absent on pre-toggle documents; getStatus() normalises that to false so the
  // existing manual-approval behaviour is the default.
  auto_approve: boolean;
  last_heartbeat_at: Date | null;
  worker_id: string | null;
  sent_today: number;
  claims_today: number;
  deliveries_today: number;
  claims_today_day: string | null;
  last_error: string | null;
  updated_at: Date;
}

function defaultState(orgId: OrgId): WorkerStateDocument {
  return {
    _id: orgId,
    paused: false,
    auto_approve: false,
    last_heartbeat_at: null,
    worker_id: null,
    sent_today: 0,
    claims_today: 0,
    deliveries_today: 0,
    claims_today_day: null,
    last_error: null,
    updated_at: new Date(0),
  };
}

function utcDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const initializedOrgs = new Set<OrgId>();

export class OutreachWorkerStateRepository {
  private col: Collection<WorkerStateDocument>;

  constructor() {
    const db = DatabaseConnection.getInstance().getDb();
    this.col = db.collection<WorkerStateDocument>(COLLECTION);
  }

  /**
   * Ensure the per-org document exists, so subsequent updates can use plain
   * $set without an upsert. MongoDB rejects $set + $setOnInsert when fields
   * overlap, which is awkward to satisfy when callers update arbitrary subsets;
   * one-shot init per org avoids that entirely.
   */
  private async ensureOrg(orgId: OrgId): Promise<void> {
    if (initializedOrgs.has(orgId)) return;
    await this.col.updateOne(
      { _id: orgId },
      { $setOnInsert: defaultState(orgId) },
      { upsert: true }
    );
    initializedOrgs.add(orgId);
  }

  async getStatus(orgId: OrgId = DEFAULT_ORG): Promise<WorkerStateDocument> {
    const doc = await this.col.findOne({ _id: orgId });
    if (!doc) return defaultState(orgId);
    // Pre-toggle documents have no auto_approve field; absent means manual.
    return { ...doc, auto_approve: doc.auto_approve === true };
  }

  async setPaused(orgId: OrgId, paused: boolean): Promise<void> {
    await this.ensureOrg(orgId);
    await this.col.updateOne(
      { _id: orgId },
      { $set: { paused, updated_at: new Date() } }
    );
  }

  async setAutoApprove(orgId: OrgId, autoApprove: boolean): Promise<void> {
    await this.ensureOrg(orgId);
    await this.col.updateOne(
      { _id: orgId },
      { $set: { auto_approve: autoApprove, updated_at: new Date() } }
    );
  }

  async setHeartbeat(orgId: OrgId, input: {
    worker_id: string;
    sent_today: number;
    last_error: string | null;
  }): Promise<void> {
    await this.ensureOrg(orgId);
    const now = new Date();
    await this.col.updateOne(
      { _id: orgId },
      {
        $set: {
          last_heartbeat_at: now,
          worker_id: input.worker_id,
          sent_today: input.sent_today,
          last_error: input.last_error,
          updated_at: now,
        },
      }
    );
  }

  async setLastError(orgId: OrgId, message: string): Promise<void> {
    await this.ensureOrg(orgId);
    await this.col.updateOne(
      { _id: orgId },
      { $set: { last_error: message, updated_at: new Date() } }
    );
  }

  /**
   * Roll both daily counters over at UTC midnight. claims_today (attempts) and
   * deliveries_today (successful sends) share one day key since they advance in
   * lockstep and reset together.
   */
  private async rollDayIfNeeded(orgId: OrgId, today: string): Promise<void> {
    await this.col.updateOne(
      { _id: orgId, claims_today_day: { $ne: today } },
      { $set: { claims_today: 0, deliveries_today: 0, claims_today_day: today, updated_at: new Date() } }
    );
  }

  /**
   * Atomically reserve one send slot for this org, rolling over at UTC midnight.
   * Grants the slot only when deliveries_today < deliveryCap (the real "N
   * delivered per day" target) — as of 2026-08 there is no separate ceiling on
   * attempts, so a bad-luck/throttled run can burn through many failures
   * chasing the delivery target rather than giving up early. claims_today is
   * still tracked and incremented here purely as an observability counter (how
   * many attempts it took); deliveries_today is bumped separately via
   * recordDelivery() when a send actually lands, so unreachable numbers never
   * consume a delivery slot. Returns the post-increment attempt count, or null
   * if the delivery cap is reached.
   */
  async tryReserveClaim(orgId: OrgId, deliveryCap: number): Promise<number | null> {
    await this.ensureOrg(orgId);
    const today = utcDayKey();
    await this.rollDayIfNeeded(orgId, today);

    const result = await this.col.findOneAndUpdate(
      { _id: orgId, deliveries_today: { $lt: deliveryCap } },
      { $inc: { claims_today: 1 }, $set: { updated_at: new Date() } },
      { returnDocument: 'after' }
    );
    if (!result) {
      return null;
    }
    return result.claims_today;
  }

  /**
   * Count one successful delivery toward this org's daily delivery cap. Called
   * from mark-sent. Rolls the day first so a send landing just after UTC midnight
   * is attributed to the new day.
   */
  async recordDelivery(orgId: OrgId): Promise<void> {
    await this.ensureOrg(orgId);
    await this.rollDayIfNeeded(orgId, utcDayKey());
    await this.col.updateOne(
      { _id: orgId },
      { $inc: { deliveries_today: 1 }, $set: { updated_at: new Date() } }
    );
  }

  async releaseClaim(orgId: OrgId): Promise<void> {
    try {
      await this.col.updateOne(
        { _id: orgId, claims_today: { $gt: 0 } },
        { $inc: { claims_today: -1 }, $set: { updated_at: new Date() } }
      );
    } catch (err) {
      Logger.warn(`worker-state releaseClaim failed: ${(err as Error).message}`);
    }
  }
}
