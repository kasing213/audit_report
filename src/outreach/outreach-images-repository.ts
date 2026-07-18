// src/outreach/outreach-images-repository.ts
import { Collection, ObjectId, Binary } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { Logger } from '../utils/logger';
import { OrgId, DEFAULT_ORG, defaultDocKey } from './orgs';

export type ImageKind = 'default' | 'proposal_custom';

export interface OutreachImageDocument {
  // Per-org default images use a string _id (defaultDocKey(orgId), e.g.
  // 'default:company'); per-proposal custom images use an ObjectId.
  _id: ObjectId | string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  data: Binary;
  uploaded_at: Date;
  uploaded_by: string;
  kind: ImageKind;
}

const COLLECTION = 'outreach_images';

let indexesReady = false;

export class OutreachImagesRepository {
  private col: Collection<OutreachImageDocument>;

  constructor() {
    const db = DatabaseConnection.getInstance().getDb();
    this.col = db.collection<OutreachImageDocument>(COLLECTION);
    if (!indexesReady) {
      indexesReady = true;
      this.col
        .createIndexes([{ key: { kind: 1 }, name: 'kind_idx' }])
        .catch((err) => Logger.error('outreach_images index creation failed', err as Error));
    }
  }

  async getDefault(orgId: OrgId = DEFAULT_ORG): Promise<OutreachImageDocument | null> {
    return this.col.findOne({ _id: defaultDocKey(orgId) } as any);
  }

  async hasDefault(orgId: OrgId = DEFAULT_ORG): Promise<boolean> {
    return (await this.col.countDocuments({ _id: defaultDocKey(orgId) } as any)) > 0;
  }

  async setDefault(input: {
    filename: string;
    mime_type: string;
    buffer: Buffer;
    uploaded_by: string;
  }, orgId: OrgId = DEFAULT_ORG): Promise<void> {
    const doc: OutreachImageDocument = {
      _id: defaultDocKey(orgId),
      filename: input.filename,
      mime_type: input.mime_type,
      size_bytes: input.buffer.length,
      data: new Binary(input.buffer),
      uploaded_at: new Date(),
      uploaded_by: input.uploaded_by,
      kind: 'default',
    };
    await this.col.replaceOne({ _id: doc._id } as any, doc, { upsert: true });
  }

  /** Remove this org's default image. Returns true when a default existed and was
   *  deleted. The bytes live in Mongo (no R2), so this fully removes it. */
  async clearDefault(orgId: OrgId = DEFAULT_ORG): Promise<boolean> {
    const result = await this.col.deleteOne({ _id: defaultDocKey(orgId) } as any);
    return result.deletedCount === 1;
  }

  async getById(id: string | ObjectId): Promise<OutreachImageDocument | null> {
    try {
      const oid = typeof id === 'string' ? new ObjectId(id) : id;
      return await this.col.findOne({ _id: oid } as any);
    } catch {
      return null;
    }
  }

  async insertCustom(input: {
    filename: string;
    mime_type: string;
    buffer: Buffer;
    uploaded_by: string;
  }): Promise<ObjectId> {
    const oid = new ObjectId();
    const doc: OutreachImageDocument = {
      _id: oid,
      filename: input.filename,
      mime_type: input.mime_type,
      size_bytes: input.buffer.length,
      data: new Binary(input.buffer),
      uploaded_at: new Date(),
      uploaded_by: input.uploaded_by,
      kind: 'proposal_custom',
    };
    await this.col.insertOne(doc as any);
    return oid;
  }

  async deleteCustom(id: string | ObjectId): Promise<boolean> {
    try {
      const oid = typeof id === 'string' ? new ObjectId(id) : id;
      const result = await this.col.deleteOne({ _id: oid, kind: 'proposal_custom' } as any);
      return result.deletedCount === 1;
    } catch {
      return false;
    }
  }
}
