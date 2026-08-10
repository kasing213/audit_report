// src/outreach/outreach-images-repository.ts
import { Collection, ObjectId, Binary } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { Logger } from '../utils/logger';
import { OrgId, DEFAULT_ORG, defaultDocKey } from './orgs';

export type ImageKind = 'default' | 'proposal_custom' | 'extra';

export interface OutreachImageDocument {
  // Per-org default images use a string _id (defaultDocKey(orgId), e.g.
  // 'default:company'); per-proposal custom images and 'extra' (additional
  // default) images use an ObjectId. org_id is only set on 'extra' docs —
  // 'default' docs are org-scoped via their _id, 'proposal_custom' docs are
  // scoped implicitly through the proposal that references them.
  _id: ObjectId | string;
  org_id?: string;
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

  /** List this org's extra (additional) default images, oldest first —
   *  ObjectId is chronological, so sorting by _id gives add-order for free. */
  async listExtras(orgId: OrgId = DEFAULT_ORG): Promise<OutreachImageDocument[]> {
    return this.col.find({ kind: 'extra', org_id: orgId } as any).sort({ _id: 1 }).toArray();
  }

  async addExtra(input: {
    filename: string;
    mime_type: string;
    buffer: Buffer;
    uploaded_by: string;
  }, orgId: OrgId = DEFAULT_ORG): Promise<ObjectId> {
    const oid = new ObjectId();
    const doc: OutreachImageDocument = {
      _id: oid,
      org_id: orgId,
      filename: input.filename,
      mime_type: input.mime_type,
      size_bytes: input.buffer.length,
      data: new Binary(input.buffer),
      uploaded_at: new Date(),
      uploaded_by: input.uploaded_by,
      kind: 'extra',
    };
    await this.col.insertOne(doc as any);
    return oid;
  }

  /** Scoped to orgId so one workspace can't delete another's extra image by
   *  guessing/reusing an id (org is otherwise just a routing dimension in
   *  this app, but delete is destructive enough to be worth the check). */
  async removeExtra(id: string | ObjectId, orgId: OrgId = DEFAULT_ORG): Promise<boolean> {
    try {
      const oid = typeof id === 'string' ? new ObjectId(id) : id;
      const result = await this.col.deleteOne({ _id: oid, kind: 'extra', org_id: orgId } as any);
      return result.deletedCount === 1;
    } catch {
      return false;
    }
  }

  /** Org-scoped lookup for an extra image (bytes route + worker fetch). */
  async getExtraById(id: string | ObjectId, orgId: OrgId = DEFAULT_ORG): Promise<OutreachImageDocument | null> {
    try {
      const oid = typeof id === 'string' ? new ObjectId(id) : id;
      return await this.col.findOne({ _id: oid, kind: 'extra', org_id: orgId } as any);
    } catch {
      return null;
    }
  }

  async sumExtraBytes(orgId: OrgId = DEFAULT_ORG): Promise<number> {
    const docs = await this.col
      .find({ kind: 'extra', org_id: orgId } as any)
      .project({ size_bytes: 1 })
      .toArray();
    return docs.reduce((sum, d: any) => sum + (d.size_bytes || 0), 0);
  }
}
