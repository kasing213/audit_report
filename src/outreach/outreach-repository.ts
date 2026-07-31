import { Collection, ObjectId } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { Logger } from '../utils/logger';
import { OrgId, orgMatch } from './orgs';

export type OutreachStatus = 'pending' | 'approved' | 'in_flight' | 'sent' | 'skipped' | 'failed';

export interface OutreachProposalDocument {
  _id?: ObjectId;
  // Outreach workspace ('company' | 'personal'). Absent on pre-multi-org
  // proposals, treated as 'company' by orgMatch(). See src/outreach/orgs.ts.
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
  // How many times a transient (crash / lease-expiry) failure has re-queued this
  // proposal. Bounded by MAX_TRANSIENT_RETRIES so a genuinely broken send cannot
  // loop forever. Absent on proposals created before this field existed.
  transient_retries?: number;
  model: string;
}

const MAX_LEASE_ATTEMPTS = 3;

const COLLECTION = 'outreach_proposals';
const RECENT_PROPOSAL_WINDOW_DAYS = 14;

let indexesReady = false;

export class OutreachRepository {
  private col: Collection<OutreachProposalDocument>;

  constructor() {
    const db = DatabaseConnection.getInstance().getDb();
    this.col = db.collection<OutreachProposalDocument>(COLLECTION);
    if (!indexesReady) {
      indexesReady = true;
      this.col
        .createIndexes([
          { key: { status: 1 }, name: 'status_idx' },
          { key: { org_id: 1, status: 1 }, name: 'org_status_idx' },
          { key: { customer_phone: 1 }, name: 'phone_idx' },
          { key: { generation_id: 1 }, name: 'generation_idx' },
          { key: { created_at: -1 }, name: 'created_at_desc' },
        ])
        .catch((err) => Logger.error('outreach_proposals index creation failed', err as Error));
    }
  }

  async insertMany(proposals: OutreachProposalDocument[]): Promise<number> {
    if (proposals.length === 0) return 0;
    const result = await this.col.insertMany(proposals);
    return result.insertedCount;
  }

  async listByStatus(orgId: OrgId, status: OutreachStatus | 'all', limit = 100): Promise<OutreachProposalDocument[]> {
    const filter: Record<string, unknown> = { org_id: orgMatch(orgId) };
    if (status !== 'all') filter.status = status;
    return this.col.find(filter).sort({ created_at: -1 }).limit(limit).toArray();
  }

  async getById(id: string): Promise<OutreachProposalDocument | null> {
    try {
      return await this.col.findOne({ _id: new ObjectId(id) });
    } catch {
      return null;
    }
  }

  async updateMessage(id: string, message: string): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), status: 'pending' },
        { $set: { message } }
      );
      // matchedCount covers the "saved with no change" case; modifiedCount would be 0.
      return result.matchedCount > 0;
    } catch {
      return false;
    }
  }

  async approve(id: string, approvedBy: string): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), status: 'pending' },
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

  async skip(id: string, reason: string): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), status: { $in: ['pending', 'approved'] } },
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
    const expiredCursor = this.col.find({ org_id: org, status: 'in_flight', lease_expires_at: { $lt: now } });
    for await (const expired of expiredCursor) {
      const attempts = (expired.claim_attempts || 0) + 1;
      if (attempts >= MAX_LEASE_ATTEMPTS) {
        await this.col.updateOne(
          { _id: expired._id },
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
          try { await onLeaseFailedFinal(expired); } catch (err) {
            Logger.error('lease-expired hook failed', err as Error);
          }
        }
      } else {
        await this.col.updateOne(
          { _id: expired._id },
          {
            $set: { status: 'approved', lease_expires_at: null, claim_attempts: attempts },
          }
        );
      }
    }

    const result = await this.col.findOneAndUpdate(
      { org_id: org, status: 'approved' },
      { $set: { status: 'in_flight', lease_expires_at: leaseExpires } },
      { sort: { approved_at: 1 }, returnDocument: 'after' }
    );
    return result as OutreachProposalDocument | null;
  }

  async markSent(id: string): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), status: 'in_flight' },
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

  async markFailed(id: string, reason: string): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        { _id: new ObjectId(id) },
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

  /**
   * Return a proposal to the approved queue after a transient failure, so the
   * worker retries it. A transient failure means the message never reached the
   * customer, so the number must NOT be treated as contacted. Refuses once
   * maxRetries is reached, at which point the caller should fail it for real.
   */
  async requeueTransient(id: string, maxRetries: number): Promise<boolean> {
    try {
      const result = await this.col.findOneAndUpdate(
        {
          _id: new ObjectId(id),
          $or: [
            { transient_retries: { $lt: maxRetries } },
            { transient_retries: { $exists: false } },
          ],
        },
        {
          $set: { status: 'approved', failed_reason: null, lease_expires_at: null },
          $inc: { transient_retries: 1 },
        },
        { returnDocument: 'after' }
      );
      return Boolean(result);
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

  async deleteAll(): Promise<number> {
    const result = await this.col.deleteMany({});
    return result.deletedCount;
  }

  async counts(orgId: OrgId): Promise<Record<OutreachStatus, number>> {
    const pipeline = [
      { $match: { org_id: orgMatch(orgId) } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ];
    const rows = await this.col.aggregate<{ _id: OutreachStatus; count: number }>(pipeline).toArray();
    const base: Record<OutreachStatus, number> = {
      pending: 0,
      approved: 0,
      in_flight: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
    };
    for (const row of rows) base[row._id] = row.count;
    return base;
  }

  async setCustomImage(id: string, imageId: ObjectId): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), status: { $in: ['pending', 'approved'] } },
        { $set: { custom_image_id: imageId } }
      );
      return result.matchedCount > 0;
    } catch {
      return false;
    }
  }

  async clearCustomImage(id: string): Promise<{ ok: boolean; previous: ObjectId | null }> {
    try {
      const existing = await this.col.findOne({ _id: new ObjectId(id) });
      if (!existing) return { ok: false, previous: null };
      const previous = existing.custom_image_id ?? null;
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), status: { $in: ['pending', 'approved'] } },
        { $set: { custom_image_id: null } }
      );
      return { ok: result.matchedCount > 0, previous };
    } catch {
      return { ok: false, previous: null };
    }
  }
}
