// src/outreach/outreach-suppression-repository.ts
/**
 * Phone-level suppression + backup-retry ledger for outreach.
 *
 * Problem it solves: a number that fails to send (typically "not on Telegram /
 * hidden by privacy") was previously re-selected into every subsequent batch
 * and re-sent forever, because a failure writes no `leads_events` doc (so the
 * phone never ages out of the stale pool) and the per-phone dedup gate ignores
 * `failed` proposals. This ledger records one doc PER PHONE (deduped) and is the
 * authoritative "do not contact" gate for candidate generation.
 *
 * Kinds:
 *   privacy   — not reachable via ImportContacts (privacy-hidden or not-yet-on-
 *               Telegram). Recoverable: retried ~every 60d, up to 3 times, then
 *               'exhausted'. Suppresses normal generation the whole time.
 *   invalid   — permanently bad number (PHONE_NUMBER_INVALID). Suppressed
 *               forever, never retried.
 *   transient — system/temporary error (timeout, mtproto blip, lease expiry,
 *               partial send). Recorded for visibility ONLY; does NOT suppress
 *               (the phone re-enters normal generation on the next scan).
 *
 * Collection: `outreach_suppressions`, unique on `customer_phone`.
 */
import { Collection, ObjectId } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { Logger } from '../utils/logger';
import { toInternationalPhone } from '../utils/phone-utils';

export type SuppressionKind = 'privacy' | 'invalid' | 'transient';
export type SuppressionStatus = 'active' | 'exhausted' | 'resolved';

export interface OutreachSuppressionDocument {
  _id?: ObjectId;
  customer_phone: string;          // toInternationalPhone-normalized — UNIQUE
  failure_kind: SuppressionKind;
  status: SuppressionStatus;
  first_failed_at: Date;
  last_failed_at: Date;
  last_failed_reason: string;
  retries_used: number;            // backup re-attempts actually minted (0..MAX_RETRIES)
  next_retry_at: Date | null;      // privacy+active → scheduled; else null
  last_proposal_id: ObjectId | null;
  customer_name: string | null;
  follower: string | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}

const COLLECTION = 'outreach_suppressions';
const RETRY_INTERVAL_DAYS = 60;
const MAX_RETRIES = 3; // ~180 days ≈ 6 months
const DAY_MS = 24 * 60 * 60 * 1000;

// Statuses/kinds that actively block a phone from normal generation.
const SUPPRESSING_KINDS: SuppressionKind[] = ['privacy', 'invalid'];
const SUPPRESSING_STATUSES: SuppressionStatus[] = ['active', 'exhausted'];

const KIND_PRIORITY: Record<SuppressionKind, number> = { transient: 1, privacy: 2, invalid: 3 };

let indexesReady = false;

/**
 * Classify a raw worker failure reason string into a suppression kind.
 * Order matters: check `invalid` before `privacy` so PHONE_NUMBER_INVALID isn't
 * swallowed by the generic paths. Note PEER_ID_INVALID is a privacy signal, not
 * an invalid-number signal, so the invalid pattern is deliberately specific.
 */
export function classifyFailure(reason: string): SuppressionKind {
  const r = (reason || '').toLowerCase();
  if (/phone[_ ]?number[_ ]?invalid|invalid \(permanent\)/.test(r)) return 'invalid';
  if (/not on telegram|hidden by privacy|phone_not_occupied|user_not_found|peer_id_invalid/.test(r)) {
    return 'privacy';
  }
  return 'transient';
}

function higherKind(a: SuppressionKind, b: SuppressionKind): SuppressionKind {
  return KIND_PRIORITY[a] >= KIND_PRIORITY[b] ? a : b;
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}

export interface RecordFailureInput {
  phone: string;
  reason: string;
  proposalId?: ObjectId | null;
  customerName?: string | null;
  follower?: string | null;
}

export interface SuppressionListQuery {
  kind?: SuppressionKind;
  status?: SuppressionStatus;
  follower?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export class OutreachSuppressionRepository {
  private col: Collection<OutreachSuppressionDocument>;

  constructor() {
    const db = DatabaseConnection.getInstance().getDb();
    this.col = db.collection<OutreachSuppressionDocument>(COLLECTION);
    if (!indexesReady) {
      indexesReady = true;
      this.col
        .createIndexes([
          { key: { customer_phone: 1 }, name: 'phone_unique', unique: true },
          { key: { status: 1, next_retry_at: 1 }, name: 'retry_due_idx' },
          { key: { status: 1, last_failed_at: -1 }, name: 'list_idx' },
        ])
        .catch((err) => Logger.error('outreach_suppressions index creation failed', err as Error));
    }
  }

  /**
   * Record a send failure for a phone. Classifies the reason, upserts the
   * per-phone doc, and (for a brand-new privacy failure) schedules the first
   * backup retry. Ongoing retry scheduling/counting is owned by bumpRetry — this
   * method never touches retries_used/next_retry_at for an in-progress privacy
   * doc, only refreshing last-failed metadata. Returns the classified kind and
   * whether the phone is now suppressed.
   */
  async recordFailure(input: RecordFailureInput): Promise<{ kind: SuppressionKind; suppressed: boolean }> {
    const phone = toInternationalPhone(input.phone.trim());
    const kind = classifyFailure(input.reason);
    const now = new Date();

    const existing = await this.col.findOne({ customer_phone: phone });

    if (!existing) {
      const doc: OutreachSuppressionDocument = {
        customer_phone: phone,
        failure_kind: kind,
        status: 'active',
        first_failed_at: now,
        last_failed_at: now,
        last_failed_reason: input.reason,
        retries_used: 0,
        next_retry_at: kind === 'privacy' ? daysFromNow(RETRY_INTERVAL_DAYS) : null,
        last_proposal_id: input.proposalId ?? null,
        customer_name: input.customerName ?? null,
        follower: input.follower ?? null,
        created_at: now,
        updated_at: now,
        resolved_at: null,
      };
      try {
        await this.col.insertOne(doc);
        return { kind, suppressed: kind !== 'transient' };
      } catch (err: any) {
        // Race: another failure inserted first. Fall through to the update path.
        if (err?.code !== 11000) throw err;
      }
    }

    // Existing doc (or lost an insert race): merge.
    const prev = existing ?? (await this.col.findOne({ customer_phone: phone }));
    const effectiveKind = prev ? higherKind(prev.failure_kind, kind) : kind;
    const set: Partial<OutreachSuppressionDocument> = {
      last_failed_at: now,
      last_failed_reason: input.reason,
      failure_kind: effectiveKind,
      updated_at: now,
    };
    if (input.customerName) set.customer_name = input.customerName;
    if (input.follower) set.follower = input.follower;
    if (input.proposalId) set.last_proposal_id = input.proposalId;

    if (prev && prev.status === 'resolved') {
      // A previously-resolved phone failed again — new episode, reset the clock.
      set.status = 'active';
      set.retries_used = 0;
      set.resolved_at = null;
      set.next_retry_at = effectiveKind === 'privacy' ? daysFromNow(RETRY_INTERVAL_DAYS) : null;
    } else if (effectiveKind === 'invalid') {
      // Upgraded to (or already) permanently invalid — never retry.
      set.next_retry_at = null;
    } else if (effectiveKind === 'privacy' && prev && prev.failure_kind === 'transient') {
      // A transient-only doc is now a real privacy failure — start the retry clock.
      set.status = 'active';
      set.next_retry_at = daysFromNow(RETRY_INTERVAL_DAYS);
    }
    // privacy-staying-privacy: leave retries_used / next_retry_at to bumpRetry.

    await this.col.updateOne({ customer_phone: phone }, { $set: set });
    return { kind: effectiveKind, suppressed: effectiveKind !== 'transient' };
  }

  /** True if this phone should be excluded from normal candidate generation. */
  async isSuppressed(phone: string): Promise<boolean> {
    const doc = await this.col.findOne({
      customer_phone: toInternationalPhone(phone.trim()),
      failure_kind: { $in: SUPPRESSING_KINDS },
      status: { $in: SUPPRESSING_STATUSES },
    });
    return Boolean(doc);
  }

  /** Set of all phones currently suppressing normal generation (for bulk filtering). */
  async getSuppressedPhones(): Promise<Set<string>> {
    const cursor = this.col.find(
      { failure_kind: { $in: SUPPRESSING_KINDS }, status: { $in: SUPPRESSING_STATUSES } },
      { projection: { customer_phone: 1, _id: 0 } }
    );
    const set = new Set<string>();
    for await (const doc of cursor) set.add(doc.customer_phone);
    return set;
  }

  /** Privacy suppressions whose next backup retry is due, oldest first, capped. */
  async listForRetry(now: Date, budget: number): Promise<OutreachSuppressionDocument[]> {
    return this.col
      .find({ failure_kind: 'privacy', status: 'active', next_retry_at: { $lte: now } })
      .sort({ next_retry_at: 1 })
      .limit(Math.max(0, budget))
      .toArray();
  }

  /**
   * Count a backup retry as spent (called when a fresh proposal is actually
   * minted for the phone). Atomically increments retries_used and reschedules
   * +60d, or marks the phone 'exhausted' once MAX_RETRIES is reached. This is
   * the SOLE owner of retries_used/next_retry_at for an in-progress privacy doc.
   */
  async bumpRetry(phone: string, proposalId: ObjectId | null): Promise<void> {
    const normalized = toInternationalPhone(phone.trim());
    const now = new Date();
    const updated = await this.col.findOneAndUpdate(
      { customer_phone: normalized, failure_kind: 'privacy', status: 'active' },
      {
        $inc: { retries_used: 1 },
        $set: { last_proposal_id: proposalId, next_retry_at: daysFromNow(RETRY_INTERVAL_DAYS), updated_at: now },
      },
      { returnDocument: 'after' }
    );
    const doc = updated as OutreachSuppressionDocument | null;
    if (doc && doc.retries_used >= MAX_RETRIES) {
      await this.col.updateOne(
        { customer_phone: doc.customer_phone },
        { $set: { status: 'exhausted', next_retry_at: null, updated_at: new Date() } }
      );
    }
  }

  /**
   * Push a due privacy retry out by another interval WITHOUT counting it as a
   * spent attempt. Used when a due phone couldn't actually be re-minted (already
   * has a live proposal, or has no customer record) so it doesn't monopolize the
   * daily retry budget on every scan.
   */
  async deferRetry(phone: string): Promise<void> {
    await this.col.updateOne(
      { customer_phone: toInternationalPhone(phone.trim()), failure_kind: 'privacy', status: 'active' },
      { $set: { next_retry_at: daysFromNow(RETRY_INTERVAL_DAYS), updated_at: new Date() } }
    );
  }

  /** Clear suppression after a confirmed successful send. Idempotent. */
  async resolve(phone: string): Promise<void> {
    const now = new Date();
    await this.col.updateOne(
      { customer_phone: toInternationalPhone(phone.trim()), status: { $ne: 'resolved' } },
      { $set: { status: 'resolved', resolved_at: now, next_retry_at: null, updated_at: now } }
    );
  }

  /** Paginated list for the Failed-numbers CRM page, plus status counts. */
  async list(query: SuppressionListQuery): Promise<{
    rows: OutreachSuppressionDocument[];
    total: number;
    counts: Record<SuppressionStatus, number>;
  }> {
    const filter: Record<string, unknown> = {};
    if (query.kind) filter.failure_kind = query.kind;
    if (query.status) filter.status = query.status;
    if (query.follower) filter.follower = query.follower;
    if (query.q) {
      const rx = new RegExp(query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ customer_phone: rx }, { customer_name: rx }];
    }

    const limit = Math.min(Math.max(1, query.limit ?? 100), 500);
    const offset = Math.max(0, query.offset ?? 0);

    const [rows, total, countRows] = await Promise.all([
      this.col.find(filter).sort({ last_failed_at: -1 }).skip(offset).limit(limit).toArray(),
      this.col.countDocuments(filter),
      this.col.aggregate<{ _id: SuppressionStatus; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]).toArray(),
    ]);

    const counts: Record<SuppressionStatus, number> = { active: 0, exhausted: 0, resolved: 0 };
    for (const c of countRows) counts[c._id] = c.count;

    return { rows, total, counts };
  }

  /**
   * One-time migration: seed suppression docs from existing `status:'failed'`
   * proposals, one per phone (latest reason wins). Privacy retries are staggered
   * so the first post-backfill retry day doesn't clump against the daily cap.
   * Idempotent — phones already having a doc are skipped.
   */
  async backfillFromFailedProposals(): Promise<{ scanned: number; created: number; skipped: number }> {
    const db = DatabaseConnection.getInstance().getDb();
    const proposals = db.collection('outreach_proposals');

    const groups = await proposals
      .aggregate<{
        _id: string;
        first_failed_at: Date;
        last_failed_at: Date;
        last_reason: string | null;
        customer_name: string | null;
        follower: string | null;
        last_proposal_id: ObjectId;
      }>([
        { $match: { status: 'failed' } },
        { $sort: { created_at: 1 } },
        {
          $group: {
            _id: '$customer_phone',
            first_failed_at: { $first: '$created_at' },
            last_failed_at: { $last: '$created_at' },
            last_reason: { $last: '$failed_reason' },
            customer_name: { $last: '$customer_name' },
            follower: { $last: '$follower' },
            last_proposal_id: { $last: '$_id' },
          },
        },
      ])
      .toArray();

    let created = 0;
    let skipped = 0;
    const now = new Date();

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (!g._id) { skipped++; continue; }
      const phone = toInternationalPhone(String(g._id).trim());

      const existing = await this.col.findOne({ customer_phone: phone });
      if (existing) { skipped++; continue; }

      const reason = g.last_reason || 'unspecified worker failure';
      const kind = classifyFailure(reason);
      // Stagger privacy retries across a 30-day spread so a big cohort doesn't
      // all come due on the same day (interacts with OUTREACH_RETRY_DAILY_BUDGET).
      const stagger = kind === 'privacy' ? daysFromNow(RETRY_INTERVAL_DAYS + (i % 30)) : null;

      const doc: OutreachSuppressionDocument = {
        customer_phone: phone,
        failure_kind: kind,
        status: 'active',
        first_failed_at: g.first_failed_at ?? now,
        last_failed_at: g.last_failed_at ?? now,
        last_failed_reason: reason,
        retries_used: 0,
        next_retry_at: stagger,
        last_proposal_id: g.last_proposal_id ?? null,
        customer_name: g.customer_name ?? null,
        follower: g.follower ?? null,
        created_at: now,
        updated_at: now,
        resolved_at: null,
      };
      try {
        await this.col.insertOne(doc);
        created++;
      } catch (err: any) {
        if (err?.code === 11000) { skipped++; continue; }
        throw err;
      }
    }

    return { scanned: groups.length, created, skipped };
  }
}
