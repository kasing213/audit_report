import { randomUUID } from 'crypto';
import { Collection, Filter, ObjectId, Sort } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { Logger } from '../utils/logger';
import { OrgId, orgMatch } from './orgs';
import { PaymentArSnapshot } from '../payment-tracker/payment-types';

/**
 * `cancelled` is an auditable terminal state used by Payment Tracker for both
 * operator rejection and source-driven cancellation (the receivable was paid,
 * or its boundary moved). Deliberately distinct from `skipped`, which keeps its
 * existing sales meaning: a human passed on a draft. A cancelled payment
 * proposal retains its dedupe key, so it goes on suppressing further reminders
 * for that phone and due date.
 */
export type OutreachStatus =
  | 'pending'
  | 'approved'
  | 'in_flight'
  | 'sent'
  | 'skipped'
  | 'failed'
  | 'cancelled';

export type OutreachProposalType = 'sales' | 'payment';

export type PaymentVerificationState = 'not_verified' | 'verified' | 'blocked';

export interface OutreachProposalDocument {
  _id?: ObjectId;
  // Outreach workspace ('company' | 'personal' | 'payment_tracker'). Absent on
  // pre-multi-org proposals, treated as 'company' by orgMatch(). See orgs.ts.
  org_id?: string | null;
  generation_id: string;
  customer_phone: string;
  customer_name: string | null;
  reason_code: string | null;
  days_since_contact: number | null;
  follower: string | null;
  message: string;
  reasoning: string;
  status: OutreachStatus;
  skipped_reason: string | null;
  failed_reason: string | null;
  custom_image_id: ObjectId | null;
  created_at: Date;
  approved_at: Date | null;
  approved_by: string | null;
  sent_at: Date | null;
  lease_expires_at: Date | null;
  claim_attempts?: number;
  model: string;

  // ---- Payment Tracker fields ----
  // All optional so every existing sales document stays valid without a
  // migration. Absent `type` means 'sales'.
  type?: OutreachProposalType;
  billing_month?: string | null;
  due_date?: string | null;
  referenced_ar_ids?: string[];
  home_references?: string[];
  customer_names?: string[];
  payment_currency?: string | null;
  payment_amount_total?: number | null;
  payment_credit_total?: number | null;
  payment_balance_due?: number | null;
  payment_ar_details?: PaymentArSnapshot[];
  source_fingerprint?: string | null;
  payment_dedupe_key?: string | null;
  send_not_before?: Date | null;
  verification_state?: PaymentVerificationState | null;
  verified_at?: Date | null;
  verification_error?: string | null;
  // Short lease held while one worker re-reads the source for this proposal, so
  // two workers cannot verify or claim the same reminder concurrently.
  verification_lease_token?: string | null;
  verification_lease_expires_at?: Date | null;
  // Bounded backoff after a blocked verification, so one unreadable receivable
  // cannot hot-loop the claim endpoint or starve the rest of the queue.
  verification_retry_after?: Date | null;
  cancelled_at?: Date | null;
  cancelled_reason?: string | null;
  cancelled_by?: string | null;
}

const MAX_LEASE_ATTEMPTS = 3;

const COLLECTION = 'outreach_proposals';
const RECENT_PROPOSAL_WINDOW_DAYS = 14;

let indexesReady = false;

export interface ProposalUpdateResult {
  matchedCount: number;
  modifiedCount: number;
  upsertedCount: number;
}

export interface ProposalFindCursor {
  sort(spec: Record<string, 1 | -1>): ProposalFindCursor;
  limit(n: number): ProposalFindCursor;
  toArray(): Promise<OutreachProposalDocument[]>;
}

/**
 * Everything the repository does to its collection, in plain Record-typed
 * terms. Exists so the repository can be driven by an in-memory double in
 * tests — the org-scoping rules below are only meaningful if something actually
 * asserts on the filters they build.
 */
export interface ProposalCollectionPort {
  findOne(filter: Record<string, unknown>): Promise<OutreachProposalDocument | null>;
  find(
    filter: Record<string, unknown>,
    options?: { projection?: Record<string, 0 | 1> }
  ): ProposalFindCursor;
  insertMany(documents: OutreachProposalDocument[]): Promise<number>;
  insertOne(document: OutreachProposalDocument): Promise<OutreachProposalDocument>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean }
  ): Promise<ProposalUpdateResult>;
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<ProposalUpdateResult>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<OutreachProposalDocument | null>;
  countDocuments(filter: Record<string, unknown>): Promise<number>;
  statusCounts(filter: Record<string, unknown>): Promise<Array<{ _id: OutreachStatus; count: number }>>;
  deleteMany(filter: Record<string, unknown>): Promise<number>;
}

export interface PaymentDraftInput {
  document: OutreachProposalDocument;
}

export interface PaymentDraftResult {
  created: boolean;
  proposal: OutreachProposalDocument | null;
}

/** Recorded as the approver when Payment Auto approves without a human. */
export const PAYMENT_AUTO_APPROVER = 'payment-auto';

/** Why a verification lease was given back without a claim. */
export interface VerificationOutcome {
  state: PaymentVerificationState;
  errorCode: string | null;
  retryAfter: Date | null;
}

/** The source-derived fields a refresh rewrites onto an existing proposal. */
export interface RefreshedPaymentFields {
  message: string;
  customer_phone: string;
  customer_name: string | null;
  billing_month: string;
  due_date: string;
  referenced_ar_ids: string[];
  home_references: string[];
  customer_names: string[];
  payment_currency: string;
  payment_amount_total: number;
  payment_credit_total: number;
  payment_balance_due: number;
  payment_ar_details: PaymentArSnapshot[];
  source_fingerprint: string;
  send_not_before: Date;
}

/** Mongo duplicate-key error code. */
function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 11000);
}

export class OutreachRepository {
  private col: ProposalCollectionPort;

  constructor(col?: ProposalCollectionPort) {
    this.col = col ?? defaultProposalCollectionPort();
  }

  async insertMany(proposals: OutreachProposalDocument[]): Promise<number> {
    if (proposals.length === 0) return 0;
    return this.col.insertMany(proposals);
  }

  async listByStatus(orgId: OrgId, status: OutreachStatus | 'all', limit = 100): Promise<OutreachProposalDocument[]> {
    const filter: Record<string, unknown> = { org_id: orgMatch(orgId) };
    if (status !== 'all') filter.status = status;
    return this.col.find(filter).sort({ created_at: -1 }).limit(limit).toArray();
  }

  /**
   * Every ID-addressed method below filters on BOTH _id and org_id.
   *
   * An ObjectId is unguessable, but the worker API is shared across workspaces
   * and a misconfigured worker declaring the wrong org would otherwise be able
   * to read another workspace's message and mark it sent. Scoping the filter —
   * rather than checking the org after the read — means a foreign proposal is
   * simply not found, and no state, cap, suppression, or alert is touched.
   */
  async getById(id: string, orgId: OrgId): Promise<OutreachProposalDocument | null> {
    try {
      return await this.col.findOne({ _id: new ObjectId(id), org_id: orgMatch(orgId) });
    } catch {
      return null;
    }
  }

  async updateMessage(id: string, orgId: OrgId, message: string): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), org_id: orgMatch(orgId), status: 'pending' },
        { $set: { message } }
      );
      // matchedCount covers the "saved with no change" case; modifiedCount would be 0.
      return result.matchedCount > 0;
    } catch {
      return false;
    }
  }

  async approve(id: string, orgId: OrgId, approvedBy: string): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), org_id: orgMatch(orgId), status: 'pending' },
        {
          $set: {
            status: 'approved',
            approved_at: new Date(),
            approved_by: approvedBy,
          },
        }
      );
      return result.modifiedCount > 0;
    } catch {
      return false;
    }
  }

  /** Open the next bounded window only after all approved/in-flight work settles. */
  async approveNextPendingWindow(orgId: OrgId, approvedBy: string, limit: number): Promise<number> {
    if (!Number.isFinite(limit) || limit <= 0) return 0;

    const org = orgMatch(orgId);
    const active = await this.col.countDocuments({
      org_id: org,
      status: { $in: ['approved', 'in_flight'] },
    });
    if (active > 0) return 0;

    const pending = await this.col
      .find({ org_id: org, status: 'pending' }, { projection: { _id: 1 } })
      .sort({ created_at: 1 })
      .limit(Math.floor(limit))
      .toArray();
    if (pending.length === 0) return 0;

    const result = await this.col.updateMany(
      { _id: { $in: pending.map((proposal) => proposal._id!) }, status: 'pending' },
      { $set: { status: 'approved', approved_at: new Date(), approved_by: approvedBy } }
    );
    return result.modifiedCount;
  }

  /**
   * Resurrect today's timeout / import-deferred failures back into the
   * approved queue. These are our own MTProto/network blips (send timeout,
   * Telegram throttling the contact import), not proof the number is dead —
   * but since 2026-08 'deferred' is a permanent suppression kind with no auto
   * retry (see outreach-suppression-repository.ts), this manual action is the
   * ONLY way such a proposal gets another attempt. Operates on the proposal
   * document directly (status only), bypassing the phone-level suppression
   * ledger entirely — claimNextApproved doesn't consult it either.
   */
  async reapproveDeferredToday(orgId: OrgId, approvedBy: string, since: Date): Promise<number> {
    const result = await this.col.updateMany(
      {
        org_id: orgMatch(orgId),
        status: 'failed',
        created_at: { $gte: since },
        failed_reason: { $regex: /send timed out after \d+s|contact import deferred by telegram/i },
      },
      { $set: { status: 'approved', approved_at: new Date(), approved_by: approvedBy } }
    );
    return result.modifiedCount;
  }

  async skip(id: string, orgId: OrgId, reason: string): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), org_id: orgMatch(orgId), status: { $in: ['pending', 'approved'] } },
        { $set: { status: 'skipped', skipped_reason: reason } }
      );
      return result.modifiedCount > 0;
    } catch {
      return false;
    }
  }

  async claimNextApproved(
    orgId: OrgId,
    leaseMs: number,
    onLeaseFailedFinal?: (proposal: OutreachProposalDocument) => Promise<void>
  ): Promise<OutreachProposalDocument | null> {
    const now = new Date();
    const leaseExpires = new Date(now.getTime() + leaseMs);
    const org = orgMatch(orgId);

    // Reclaim expired in_flight leases. Increment claim_attempts; if the cap
    // is hit, flip to `failed` so the same broken proposal doesn't loop forever.
    const expired = await this.col
      .find({ org_id: org, status: 'in_flight', lease_expires_at: { $lt: now } })
      .toArray();
    for (const proposal of expired) {
      const attempts = (proposal.claim_attempts || 0) + 1;
      if (attempts >= MAX_LEASE_ATTEMPTS) {
        await this.col.updateOne(
          { _id: proposal._id },
          {
            $set: {
              status: 'failed',
              failed_reason: 'lease expired without resolution (3rd attempt)',
              lease_expires_at: null,
              claim_attempts: attempts,
            },
          }
        );
        if (onLeaseFailedFinal) {
          try { await onLeaseFailedFinal(proposal); } catch (err) {
            Logger.error('lease-expired hook failed', err as Error);
          }
        }
      } else {
        await this.col.updateOne(
          { _id: proposal._id },
          {
            $set: { status: 'approved', lease_expires_at: null, claim_attempts: attempts },
          }
        );
      }
    }

    return this.col.findOneAndUpdate(
      { org_id: org, status: 'approved' },
      { $set: { status: 'in_flight', lease_expires_at: leaseExpires } },
      { sort: { approved_at: 1 }, returnDocument: 'after' }
    );
  }

  async markSent(id: string, orgId: OrgId): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), org_id: orgMatch(orgId), status: 'in_flight' },
        {
          $set: {
            status: 'sent',
            sent_at: new Date(),
            lease_expires_at: null,
          },
        }
      );
      return result.modifiedCount > 0;
    } catch {
      return false;
    }
  }

  async markFailed(id: string, orgId: OrgId, reason: string): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), org_id: orgMatch(orgId) },
        {
          $set: {
            status: 'failed',
            failed_reason: reason,
            lease_expires_at: null,
          },
        }
      );
      return result.modifiedCount > 0;
    } catch {
      return false;
    }
  }

  async hasRecentProposalForPhone(phone: string, orgId: OrgId): Promise<boolean> {
    const cutoff = new Date(Date.now() - RECENT_PROPOSAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const existing = await this.col.findOne({
      org_id: orgMatch(orgId),
      customer_phone: phone,
      status: { $in: ['pending', 'approved', 'in_flight', 'sent'] },
      created_at: { $gte: cutoff },
    });
    return Boolean(existing);
  }

  /**
   * Proposals still awaiting action for this workspace — anything a human could
   * approve or the worker could still send. Drives the scan's top-up rule so the
   * queue never grows past its target.
   */
  async countOutstanding(orgId: OrgId): Promise<number> {
    return this.col.countDocuments({
      org_id: orgMatch(orgId),
      status: { $in: ['pending', 'approved'] },
    });
  }

  /** Scoped to one workspace — clearing Company must not wipe Personal or Payment. */
  async deleteAll(orgId: OrgId): Promise<number> {
    return this.col.deleteMany({ org_id: orgMatch(orgId) });
  }

  async counts(orgId: OrgId): Promise<Record<OutreachStatus, number>> {
    const rows = await this.col.statusCounts({ org_id: orgMatch(orgId) });
    const base: Record<OutreachStatus, number> = {
      pending: 0,
      approved: 0,
      in_flight: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const row of rows) base[row._id] = row.count;
    return base;
  }

  async setCustomImage(id: string, orgId: OrgId, imageId: ObjectId): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), org_id: orgMatch(orgId), status: { $in: ['pending', 'approved'] } },
        { $set: { custom_image_id: imageId } }
      );
      return result.matchedCount > 0;
    } catch {
      return false;
    }
  }

  async clearCustomImage(id: string, orgId: OrgId): Promise<{ ok: boolean; previous: ObjectId | null }> {
    try {
      const existing = await this.col.findOne({ _id: new ObjectId(id), org_id: orgMatch(orgId) });
      if (!existing) return { ok: false, previous: null };
      const previous = existing.custom_image_id ?? null;
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), org_id: orgMatch(orgId), status: { $in: ['pending', 'approved'] } },
        { $set: { custom_image_id: null } }
      );
      return { ok: result.matchedCount > 0, previous };
    } catch {
      return { ok: false, previous: null };
    }
  }

  // ---- Payment Tracker ----

  /**
   * Insert one payment draft, or report that its boundary is already taken.
   *
   * The dedupe key is (payment_tracker, normalized phone, exact local due date)
   * and survives every terminal state — sent, failed, cancelled alike. So a
   * customer who was already reminded about this due date, or whose reminder
   * failed, or whose draft an operator rejected, does not get a second one.
   * A losing insert is reported, never resolved by deleting the existing
   * proposal: that record IS the suppression.
   */
  async upsertPaymentDraft(input: PaymentDraftInput): Promise<PaymentDraftResult> {
    const key = input.document.payment_dedupe_key;
    if (!key) throw new Error('payment proposal requires a payment_dedupe_key');

    const existing = await this.col.findOne({ payment_dedupe_key: key });
    if (existing) return { created: false, proposal: existing };

    try {
      const proposal = await this.col.insertOne(input.document);
      return { created: true, proposal };
    } catch (err) {
      // Lost a race against a concurrent scan; the partial unique index held.
      if (isDuplicateKeyError(err) || String((err as Error)?.message).includes('payment_dedupe_unique')) {
        return { created: false, proposal: await this.col.findOne({ payment_dedupe_key: key }) };
      }
      throw err;
    }
  }

  async countByDedupeKey(key: string): Promise<number> {
    return this.col.countDocuments({ payment_dedupe_key: key });
  }

  /**
   * Terminal, auditable cancellation of a payment proposal — operator rejection
   * or a source change that made the reminder wrong. Keeps payment_dedupe_key
   * so the boundary stays suppressed, and records who/why/when.
   */
  /**
   * Take a short exclusive lease on one approved payment proposal that is due,
   * so exactly one worker re-reads the source for it.
   *
   * org_id is matched EXACTLY here, never through orgMatch(): the Company
   * compatibility widening ({ $in: [null, 'company'] }) exists for legacy sales
   * documents and must never be able to select one into the payment path.
   *
   * The lease is what makes verification safe under concurrency. Without it two
   * workers could both read "unchanged", both finalize, and both send the same
   * reminder.
   */
  async acquirePaymentVerificationLease(
    orgId: OrgId,
    now: Date,
    leaseMs: number
  ): Promise<{ proposal: OutreachProposalDocument; leaseToken: string } | null> {
    const leaseToken = randomUUID();
    const proposal = await this.col.findOneAndUpdate(
      {
        org_id: orgId,
        type: 'payment',
        status: 'approved',
        // Never before local midnight on the exact due date.
        send_not_before: { $lte: now },
        $and: [
          {
            $or: [
              { verification_lease_expires_at: null },
              { verification_lease_expires_at: { $lte: now } },
            ],
          },
          {
            $or: [
              { verification_retry_after: null },
              { verification_retry_after: { $lte: now } },
            ],
          },
        ],
      },
      {
        $set: {
          verification_lease_token: leaseToken,
          verification_lease_expires_at: new Date(now.getTime() + leaseMs),
        },
      },
      { sort: { send_not_before: 1, approved_at: 1 }, returnDocument: 'after' }
    );

    return proposal ? { proposal, leaseToken } : null;
  }

  /**
   * Give the lease back without claiming. `outcome` records why: a blocked
   * verification also gets a machine-readable code and a retry time, so one
   * unreadable receivable backs off instead of hot-looping the claim endpoint.
   */
  async releasePaymentVerificationLease(
    id: string,
    orgId: OrgId,
    leaseToken: string,
    outcome: VerificationOutcome
  ): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), org_id: orgId, verification_lease_token: leaseToken },
        {
          $set: {
            verification_state: outcome.state,
            verification_error: outcome.errorCode,
            verification_retry_after: outcome.retryAfter,
            verification_lease_token: null,
            verification_lease_expires_at: null,
          },
        }
      );
      return result.matchedCount > 0;
    } catch {
      return false;
    }
  }

  /**
   * The single compare-and-set that hands a reminder to the worker.
   *
   * Matches on id, exact org, still-approved status, the lease we hold, AND the
   * fingerprint we just verified. If anything moved between the source reread
   * and this write, the update matches nothing and no send happens.
   */
  async finalizeVerifiedPaymentClaim(
    id: string,
    orgId: OrgId,
    leaseToken: string,
    fingerprint: string,
    claimLeaseUntil: Date,
    now: Date
  ): Promise<OutreachProposalDocument | null> {
    try {
      return await this.col.findOneAndUpdate(
        {
          _id: new ObjectId(id),
          org_id: orgId,
          type: 'payment',
          status: 'approved',
          verification_lease_token: leaseToken,
          source_fingerprint: fingerprint,
        },
        {
          $set: {
            status: 'in_flight',
            lease_expires_at: claimLeaseUntil,
            verification_state: 'verified',
            verified_at: now,
            verification_error: null,
            verification_retry_after: null,
            verification_lease_token: null,
            verification_lease_expires_at: null,
          },
        },
        { returnDocument: 'after' }
      );
    } catch {
      return null;
    }
  }

  /**
   * Rewrite a proposal whose source moved but whose dedupe boundary did not.
   *
   * In manual mode approval is revoked and the draft returns to `pending`, so a
   * human sees the new figures before anything sends. In auto mode it stays
   * approved but is NOT returned to the worker in this request — it must pass a
   * fresh verification first.
   */
  async refreshPaymentProposal(
    id: string,
    orgId: OrgId,
    leaseToken: string,
    refreshed: RefreshedPaymentFields,
    mode: 'manual' | 'auto',
    now: Date
  ): Promise<OutreachProposalDocument | null> {
    try {
      return await this.col.findOneAndUpdate(
        { _id: new ObjectId(id), org_id: orgId, type: 'payment', verification_lease_token: leaseToken },
        {
          $set: {
            ...refreshed,
            status: mode === 'auto' ? 'approved' : 'pending',
            approved_at: mode === 'auto' ? now : null,
            approved_by: mode === 'auto' ? PAYMENT_AUTO_APPROVER : null,
            verification_state: 'not_verified',
            verification_error: null,
            verification_retry_after: null,
            verification_lease_token: null,
            verification_lease_expires_at: null,
          },
        },
        { returnDocument: 'after' }
      );
    } catch {
      return null;
    }
  }

  async cancelPayment(id: string, orgId: OrgId, reason: string, actor: string): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        {
          _id: new ObjectId(id),
          org_id: orgMatch(orgId),
          status: { $in: ['pending', 'approved', 'in_flight'] },
        },
        {
          $set: {
            status: 'cancelled',
            cancelled_at: new Date(),
            cancelled_reason: reason,
            cancelled_by: actor,
            lease_expires_at: null,
          },
        }
      );
      return result.modifiedCount > 0;
    } catch {
      return false;
    }
  }
}

/**
 * The Mongo-backed port. Exported so a caller that injects its dependencies —
 * the payment scanner does — can still run against the real collection without
 * reimplementing the adapter.
 */
export function defaultProposalCollectionPort(): ProposalCollectionPort {
  const collection = DatabaseConnection.getInstance()
    .getDb()
    .collection<OutreachProposalDocument>(COLLECTION);

  if (!indexesReady) {
    indexesReady = true;
    collection
      .createIndexes([
        { key: { status: 1 }, name: 'status_idx' },
        { key: { org_id: 1, status: 1 }, name: 'org_status_idx' },
        { key: { customer_phone: 1 }, name: 'phone_idx' },
        { key: { generation_id: 1 }, name: 'generation_idx' },
        { key: { created_at: -1 }, name: 'created_at_desc' },
        // Payment reminders are deduplicated on (phone, exact local due date)
        // for the lifetime of the proposal, terminal states included. Partial
        // so legacy sales documents — which have no payment_dedupe_key — are
        // untouched and cannot collide with each other on a null key.
        {
          key: { payment_dedupe_key: 1 },
          name: 'payment_dedupe_unique',
          unique: true,
          partialFilterExpression: { type: 'payment', payment_dedupe_key: { $type: 'string' } },
        },
      ])
      .catch((err) => Logger.error('outreach_proposals index creation failed', err as Error));
  }

  return mongoProposalPort(collection);
}

/**
 * Adapter from the real Mongo collection to ProposalCollectionPort. Written
 * explicitly rather than relying on structural assignability so the driver's
 * Filter<T>/Sort types stay contained in this one function.
 */
function mongoProposalPort(col: Collection<OutreachProposalDocument>): ProposalCollectionPort {
  const asFilter = (filter: Record<string, unknown>) => filter as Filter<OutreachProposalDocument>;

  return {
    findOne: (filter) => col.findOne(asFilter(filter)) as Promise<OutreachProposalDocument | null>,
    find: (filter, options) => wrapCursor(col.find(asFilter(filter), options ?? {})),
    insertMany: async (documents) => (await col.insertMany(documents)).insertedCount,
    insertOne: async (document) => {
      const result = await col.insertOne(document);
      return { ...document, _id: result.insertedId };
    },
    updateOne: async (filter, update, options) => {
      const result = await col.updateOne(asFilter(filter), update, { upsert: options?.upsert === true });
      return {
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        upsertedCount: result.upsertedCount,
      };
    },
    updateMany: async (filter, update) => {
      const result = await col.updateMany(asFilter(filter), update);
      return {
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        upsertedCount: result.upsertedCount,
      };
    },
    findOneAndUpdate: async (filter, update, options) => {
      const result = await col.findOneAndUpdate(asFilter(filter), update, {
        ...(options as { sort?: Sort; returnDocument?: 'before' | 'after' }),
      });
      return result as OutreachProposalDocument | null;
    },
    countDocuments: (filter) => col.countDocuments(asFilter(filter)),
    statusCounts: (filter) =>
      col
        .aggregate<{ _id: OutreachStatus; count: number }>([
          { $match: filter },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ])
        .toArray(),
    deleteMany: async (filter) => (await col.deleteMany(asFilter(filter))).deletedCount,
  };
}

function wrapCursor(cursor: {
  sort(spec: Sort): unknown;
  limit(n: number): unknown;
  toArray(): Promise<unknown[]>;
}): ProposalFindCursor {
  return {
    sort(spec) {
      cursor.sort(spec as Sort);
      return this;
    },
    limit(n) {
      cursor.limit(n);
      return this;
    },
    toArray: () => cursor.toArray() as Promise<OutreachProposalDocument[]>,
  };
}
