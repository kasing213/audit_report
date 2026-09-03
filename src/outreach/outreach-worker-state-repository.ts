import { Collection } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { Logger } from '../utils/logger';
import { OrgId, DEFAULT_ORG, PAYMENT_TRACKER_ORG } from './orgs';

const COLLECTION = 'outreach_worker_state';

const CAMBODIA_TZ = 'Asia/Phnom_Penh';

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
  // Payment Tracker only. In-flight sends that have been granted a delivery
  // slot but have not yet landed. deliveries_today + delivery_reservations is
  // what the cap is checked against, so concurrent Payment workers cannot
  // collectively exceed it by all passing the check before any of them
  // finishes. Company/Personal keep their existing attempt-counter behaviour.
  delivery_reservations: number;
  last_error: string | null;
  updated_at: Date;
}

export function defaultState(orgId: OrgId): WorkerStateDocument {
  return {
    _id: orgId,
    // Payment Tracker starts paused so that standing up its worker cannot send
    // anything until an operator explicitly resumes it. Company and Personal
    // keep their existing default.
    paused: orgId === PAYMENT_TRACKER_ORG,
    auto_approve: false,
    last_heartbeat_at: null,
    worker_id: null,
    sent_today: 0,
    claims_today: 0,
    deliveries_today: 0,
    claims_today_day: null,
    delivery_reservations: 0,
    last_error: null,
    updated_at: new Date(0),
  };
}

function utcDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Which calendar a workspace's daily counters roll on.
 *
 * Company and Personal have always rolled at UTC midnight (07:00 Cambodia) and
 * are left exactly as they were — changing that would silently move their cap
 * window. Payment Tracker is new, and its reminders are gated on Cambodia local
 * due dates, so its cap rolls on the same Cambodia calendar. The state
 * documents are per-org, so the two conventions coexist without interfering.
 */
function dayKeyFor(orgId: OrgId, now = new Date()): string {
  if (orgId !== PAYMENT_TRACKER_ORG) return utcDayKey(now);
  // Format the supplied instant, not "right now" — the caller passes the same
  // instant it uses for the reservation, and a mismatch here would roll the
  // day mid-request and silently reset the cap counters.
  return new Intl.DateTimeFormat('en-CA', { timeZone: CAMBODIA_TZ }).format(now);
}

/**
 * The subset of collection operations this repository performs, so the delivery
 * reservation guard can be exercised without a database.
 */
export interface WorkerStateCollectionPort {
  findOne(filter: Record<string, unknown>): Promise<WorkerStateDocument | null>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean }
  ): Promise<void>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<WorkerStateDocument | null>;
}

/** Process-wide memo for the Mongo-backed path: one init upsert per org. */
const initializedOrgs = new Set<OrgId>();

export class OutreachWorkerStateRepository {
  private col: WorkerStateCollectionPort;
  /** Injected ports get their own memo so tests never share init state. */
  private readonly initialized: Set<OrgId>;

  constructor(col?: WorkerStateCollectionPort) {
    this.col = col ?? mongoWorkerStatePort();
    this.initialized = col ? new Set<OrgId>() : initializedOrgs;
  }

  /**
   * Ensure the per-org document exists, so subsequent updates can use plain
   * $set without an upsert. MongoDB rejects $set + $setOnInsert when fields
   * overlap, which is awkward to satisfy when callers update arbitrary subsets;
   * one-shot init per org avoids that entirely.
   */
  private async ensureOrg(orgId: OrgId): Promise<void> {
    if (this.initialized.has(orgId)) return;
    await this.col.updateOne(
      { _id: orgId },
      { $setOnInsert: defaultState(orgId) },
      { upsert: true }
    );
    this.initialized.add(orgId);
  }

  async getStatus(orgId: OrgId = DEFAULT_ORG): Promise<WorkerStateDocument> {
    const doc = await this.col.findOne({ _id: orgId });
    if (!doc) return defaultState(orgId);
    // Pre-toggle documents have no auto_approve field; absent means manual.
    return { ...doc, auto_approve: doc.auto_approve === true };
  }

  /** Auto-approval flag for one workspace. Absent field means manual. */
  async getAutoApprove(orgId: OrgId): Promise<boolean> {
    return (await this.getStatus(orgId)).auto_approve === true;
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
      {
        $set: {
          claims_today: 0,
          deliveries_today: 0,
          delivery_reservations: 0,
          claims_today_day: today,
          updated_at: new Date(),
        },
      }
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

  /**
   * Reserve one Payment delivery slot, or refuse.
   *
   * The cap is on SUCCESSFUL deliveries, so it cannot be enforced by counting
   * completed sends alone: fifteen workers could each see deliveries_today = 0,
   * all pass the check, and all send. The reservation is taken up front and the
   * guard compares cap against deliveries_today + delivery_reservations in a
   * single atomic findOneAndUpdate, which requires $expr because it compares
   * two fields of the same document.
   *
   * Company/Personal deliberately keep tryReserveClaim() unchanged.
   */
  async tryReservePaymentDelivery(orgId: OrgId, cap: number, now: Date): Promise<boolean> {
    await this.ensureOrg(orgId);
    await this.rollDayIfNeeded(orgId, dayKeyFor(orgId, now));

    const result = await this.col.findOneAndUpdate(
      {
        _id: orgId,
        $expr: { $lt: [{ $add: ['$deliveries_today', '$delivery_reservations'] }, cap] },
      },
      { $inc: { delivery_reservations: 1 }, $set: { updated_at: now } },
      { returnDocument: 'after' }
    );
    return result !== null;
  }

  /** A Payment send landed: convert the reservation into a counted delivery. */
  async completePaymentDelivery(orgId: OrgId, now: Date): Promise<void> {
    await this.ensureOrg(orgId);
    await this.rollDayIfNeeded(orgId, dayKeyFor(orgId, now));
    await this.col.updateOne(
      { _id: orgId },
      { $inc: { deliveries_today: 1 }, $set: { updated_at: now } }
    );
    await this.releasePaymentDelivery(orgId, now);
  }

  /**
   * Hand a Payment reservation back — failed send, nothing claimed, or an
   * expired lease. Guarded on a positive count so a double release cannot drive
   * the reservation negative and quietly widen the cap.
   */
  async releasePaymentDelivery(orgId: OrgId, now: Date): Promise<void> {
    try {
      await this.col.updateOne(
        { _id: orgId, delivery_reservations: { $gt: 0 } },
        { $inc: { delivery_reservations: -1 }, $set: { updated_at: now } }
      );
    } catch (err) {
      Logger.warn(`worker-state releasePaymentDelivery failed: ${(err as Error).message}`);
    }
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

/** Adapter from the real Mongo collection to WorkerStateCollectionPort. */
function mongoWorkerStatePort(): WorkerStateCollectionPort {
  const col: Collection<WorkerStateDocument> = DatabaseConnection.getInstance()
    .getDb()
    .collection<WorkerStateDocument>(COLLECTION);

  return {
    findOne: (filter) => col.findOne(filter as Record<string, never>),
    updateOne: async (filter, update, options) => {
      await col.updateOne(filter as Record<string, never>, update, { upsert: options?.upsert === true });
    },
    findOneAndUpdate: async (filter, update, options) =>
      (await col.findOneAndUpdate(filter as Record<string, never>, update, {
        ...(options as { returnDocument?: 'before' | 'after' }),
      })) as WorkerStateDocument | null,
  };
}
