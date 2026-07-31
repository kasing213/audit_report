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
import { OrgId, DEFAULT_ORG, orgMatch } from './orgs';

export type SuppressionKind = 'privacy' | 'invalid' | 'transient' | 'contacted';
export type SuppressionStatus = 'active' | 'exhausted' | 'resolved';

export interface OutreachSuppressionDocument {
  _id?: ObjectId;
  // Outreach workspace ('company' | 'personal'). Absent on pre-multi-org docs,
  // treated as 'company' by orgMatch(). Uniqueness is per (org_id, phone) so the
  // same number can have an independent ledger entry in each org.
  org_id?: string | null;
  customer_phone: string;          // toInternationalPhone-normalized — unique per org
  failure_kind: SuppressionKind;
  status: SuppressionStatus;
  first_failed_at: Date;
  last_failed_at: Date;
  last_failed_reason: string;
  retries_used: number;            // backup re-attempts actually minted (0..MAX_RETRIES)
  next_retry_at: Date | null;      // privacy+active → scheduled; else null
  // 'contacted' records only: when this phone becomes eligible for outreach
  // again (contacted_at + CONTACT_COOLDOWN_DAYS). Null for failure records,
  // which are governed by failure_kind instead of by a clock.
  eligible_again_at?: Date | null;
  contacted_at?: Date | null;
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

/**
 * How long a successfully-contacted number stays out of the pool. Replaces the
 * old behaviour where OUTREACH_STALE_DAYS (45) governed re-contact.
 */
export const CONTACT_COOLDOWN_DAYS = 180;

// Statuses/kinds that actively block a phone from normal generation.
const SUPPRESSING_KINDS: SuppressionKind[] = ['privacy', 'invalid'];
const SUPPRESSING_STATUSES: SuppressionStatus[] = ['active', 'exhausted'];

// 'contacted' is lowest priority: it's not a failure at all, so any real
// failure kind (even 'transient') on a formerly-contacted phone should win.
const KIND_PRIORITY: Record<SuppressionKind, number> = { contacted: 0, transient: 1, privacy: 2, invalid: 3 };

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
  orgId?: OrgId;
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
          // Unique per (org, phone) so company and personal keep independent
          // ledgers for the same number. The legacy single-field 'phone_unique'
          // index is dropped by scripts/backfill-org-company.ts on existing DBs.
          { key: { org_id: 1, customer_phone: 1 }, name: 'org_phone_unique', unique: true },
          { key: { status: 1, next_retry_at: 1 }, name: 'retry_due_idx' },
          { key: { status: 1, last_failed_at: -1 }, name: 'list_idx' },
          { key: { org_id: 1, failure_kind: 1, eligible_again_at: 1 }, name: 'cooldown_idx' },
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
    const orgId = input.orgId ?? DEFAULT_ORG;
    const org = orgMatch(orgId);
    const kind = classifyFailure(input.reason);
    const now = new Date();

    const existing = await this.col.findOne({ org_id: org, customer_phone: phone });

    if (!existing) {
      const doc: OutreachSuppressionDocument = {
        org_id: orgId,
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
    const prev = existing ?? (await this.col.findOne({ org_id: org, customer_phone: phone }));
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

    await this.col.updateOne({ org_id: org, customer_phone: phone }, { $set: set });
    return { kind: effectiveKind, suppressed: effectiveKind !== 'transient' };
  }

  /** True if this phone should be excluded from normal candidate generation. */
  async isSuppressed(phone: string, orgId: OrgId = DEFAULT_ORG): Promise<boolean> {
    const doc = await this.col.findOne({
      org_id: orgMatch(orgId),
      customer_phone: toInternationalPhone(phone.trim()),
      failure_kind: { $in: SUPPRESSING_KINDS },
      status: { $in: SUPPRESSING_STATUSES },
    });
    return Boolean(doc);
  }

  /**
   * Record a successful send, starting this phone's 180-day cooldown for this
   * workspace. Overwrites any prior failure record for the same (org, phone) —
   * a number that finally delivered is contacted, not failed, so it also leaves
   * the Failed list. `last_failed_at` is set alongside `contacted_at` purely so
   * the existing `list_idx` sort and the failed-numbers UI have a non-null date
   * to work with.
   */
  async recordContacted(input: {
    phone: string;
    orgId?: OrgId;
    proposalId?: ObjectId | null;
    customerName?: string | null;
    follower?: string | null;
    sentAt?: Date;
  }): Promise<void> {
    const phone = toInternationalPhone(input.phone.trim());
    const orgId = input.orgId ?? DEFAULT_ORG;
    const contactedAt = input.sentAt ?? new Date();
    const eligibleAgainAt = new Date(contactedAt.getTime() + CONTACT_COOLDOWN_DAYS * DAY_MS);
    const now = new Date();

    await this.col.updateOne(
      { org_id: orgId, customer_phone: phone },
      {
        $set: {
          failure_kind: 'contacted' as SuppressionKind,
          status: 'active' as SuppressionStatus,
          contacted_at: contactedAt,
          eligible_again_at: eligibleAgainAt,
          last_failed_at: contactedAt,
          last_failed_reason: `contacted — ${CONTACT_COOLDOWN_DAYS}d cooldown`,
          next_retry_at: null,
          last_proposal_id: input.proposalId ?? null,
          customer_name: input.customerName ?? null,
          follower: input.follower ?? null,
          resolved_at: null,
          updated_at: now,
        },
        $setOnInsert: {
          first_failed_at: contactedAt,
          retries_used: 0,
          created_at: now,
        },
      },
      { upsert: true }
    );
  }

  /**
   * Phones this workspace must not draft. Two independent reasons:
   *   - a permanent failure (privacy / invalid), which never expires;
   *   - an active contact cooldown, which expires at eligible_again_at.
   */
  async getSuppressedPhones(orgId: OrgId = DEFAULT_ORG): Promise<Set<string>> {
    const now = new Date();
    const cursor = this.col.find(
      {
        org_id: orgMatch(orgId),
        $or: [
          { failure_kind: { $in: SUPPRESSING_KINDS }, status: { $in: SUPPRESSING_STATUSES } },
          { failure_kind: 'contacted', eligible_again_at: { $gt: now } },
        ],
      },
      { projection: { customer_phone: 1, _id: 0 } }
    );
    const set = new Set<string>();
    for await (const doc of cursor) set.add(doc.customer_phone);
    return set;
  }

  /** Privacy suppressions whose next backup retry is due, oldest first, capped. */
  async listForRetry(now: Date, budget: number, orgId: OrgId = DEFAULT_ORG): Promise<OutreachSuppressionDocument[]> {
    return this.col
      .find({ org_id: orgMatch(orgId), failure_kind: 'privacy', status: 'active', next_retry_at: { $lte: now } })
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
  async bumpRetry(phone: string, proposalId: ObjectId | null, orgId: OrgId = DEFAULT_ORG): Promise<void> {
    const normalized = toInternationalPhone(phone.trim());
    const org = orgMatch(orgId);
    const now = new Date();
    const updated = await this.col.findOneAndUpdate(
      { org_id: org, customer_phone: normalized, failure_kind: 'privacy', status: 'active' },
      {
        $inc: { retries_used: 1 },
        $set: { last_proposal_id: proposalId, next_retry_at: daysFromNow(RETRY_INTERVAL_DAYS), updated_at: now },
      },
      { returnDocument: 'after' }
    );
    const doc = updated as OutreachSuppressionDocument | null;
    if (doc && doc.retries_used >= MAX_RETRIES) {
      await this.col.updateOne(
        { org_id: org, customer_phone: doc.customer_phone },
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
  async deferRetry(phone: string, orgId: OrgId = DEFAULT_ORG): Promise<void> {
    await this.col.updateOne(
      { org_id: orgMatch(orgId), customer_phone: toInternationalPhone(phone.trim()), failure_kind: 'privacy', status: 'active' },
      { $set: { next_retry_at: daysFromNow(RETRY_INTERVAL_DAYS), updated_at: new Date() } }
    );
  }

  /** Clear suppression after a confirmed successful send. Idempotent. */
  async resolve(phone: string, orgId: OrgId = DEFAULT_ORG): Promise<void> {
    const now = new Date();
    await this.col.updateOne(
      { org_id: orgMatch(orgId), customer_phone: toInternationalPhone(phone.trim()), status: { $ne: 'resolved' } },
      { $set: { status: 'resolved', resolved_at: now, next_retry_at: null, updated_at: now } }
    );
  }

  /** Paginated list for the Failed-numbers CRM page, plus status counts. */
  async list(query: SuppressionListQuery, orgId: OrgId = DEFAULT_ORG): Promise<{
    rows: OutreachSuppressionDocument[];
    total: number;
    counts: Record<SuppressionStatus, number>;
  }> {
    const filter: Record<string, unknown> = { org_id: orgMatch(orgId) };
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
        { $match: { org_id: orgMatch(orgId) } },
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
        _id: { phone: string; org_id: string | null };
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
          // One suppression per (org, phone) so each workspace keeps its own ledger.
          $group: {
            _id: { phone: '$customer_phone', org_id: { $ifNull: ['$org_id', DEFAULT_ORG] } },
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
      if (!g._id || !g._id.phone) { skipped++; continue; }
      const phone = toInternationalPhone(String(g._id.phone).trim());
      const orgId = g._id.org_id ?? DEFAULT_ORG;

      const existing = await this.col.findOne({ org_id: orgMatch(orgId), customer_phone: phone });
      if (existing) { skipped++; continue; }

      const reason = g.last_reason || 'unspecified worker failure';
      const kind = classifyFailure(reason);
      // Stagger privacy retries across a 30-day spread so a big cohort doesn't
      // all come due on the same day (interacts with OUTREACH_RETRY_DAILY_BUDGET).
      const stagger = kind === 'privacy' ? daysFromNow(RETRY_INTERVAL_DAYS + (i % 30)) : null;

      const doc: OutreachSuppressionDocument = {
        org_id: orgId,
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
