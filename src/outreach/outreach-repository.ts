import { Collection, ObjectId } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { Logger } from '../utils/logger';

export type OutreachStatus = 'pending' | 'approved' | 'in_flight' | 'sent' | 'skipped' | 'failed';

export interface OutreachProposalDocument {
  _id?: ObjectId;
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
  created_at: Date;
  approved_at: Date | null;
  approved_by: string | null;
  sent_at: Date | null;
  lease_expires_at: Date | null;
  model: string;
}

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

  async listByStatus(status: OutreachStatus | 'all', limit = 100): Promise<OutreachProposalDocument[]> {
    const filter = status === 'all' ? {} : { status };
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
      return result.modifiedCount > 0;
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

  async claimNextApproved(leaseMs: number): Promise<OutreachProposalDocument | null> {
    const now = new Date();
    const leaseExpires = new Date(now.getTime() + leaseMs);

    // First, release any expired in_flight leases.
    await this.col.updateMany(
      { status: 'in_flight', lease_expires_at: { $lt: now } },
      { $set: { status: 'approved', lease_expires_at: null } }
    );

    const result = await this.col.findOneAndUpdate(
      { status: 'approved' },
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

  async hasRecentProposalForPhone(phone: string): Promise<boolean> {
    const cutoff = new Date(Date.now() - RECENT_PROPOSAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const existing = await this.col.findOne({
      customer_phone: phone,
      status: { $in: ['pending', 'approved', 'in_flight', 'sent'] },
      created_at: { $gte: cutoff },
    });
    return Boolean(existing);
  }

  async deleteAll(): Promise<number> {
    const result = await this.col.deleteMany({});
    return result.deletedCount;
  }

  async counts(): Promise<Record<OutreachStatus, number>> {
    const pipeline = [{ $group: { _id: '$status', count: { $sum: 1 } } }];
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
}
