// src/outreach/outreach-video-repository.ts
/**
 * Stores METADATA for the single default marketing video — never the bytes.
 * The 50MB video lives in Cloudflare R2 (see R2StorageService); this repo holds
 * only the pointer (r2_key) plus display metadata, in the `outreach_media`
 * Mongo collection as one fixed doc `_id: 'default'`. Mirrors the shape of
 * OutreachImagesRepository minus the Binary `data` field.
 */
import { Collection, ObjectId } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { Logger } from '../utils/logger';
import { OrgId, DEFAULT_ORG, defaultDocKey } from './orgs';

export interface OutreachVideoDocument {
  _id: string; // defaultDocKey(orgId), e.g. 'default:company'
  r2_key: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: Date;
  uploaded_by: string;
}

export interface OutreachExtraVideoDocument {
  _id: ObjectId;
  org_id: string;
  r2_key: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: Date;
  uploaded_by: string;
}

const COLLECTION = 'outreach_media';

export class OutreachVideoRepository {
  private col: Collection<OutreachVideoDocument>;
  private extraCol: Collection<OutreachExtraVideoDocument>;

  constructor() {
    const db = DatabaseConnection.getInstance().getDb();
    this.col = db.collection<OutreachVideoDocument>(COLLECTION);
    this.extraCol = db.collection<OutreachExtraVideoDocument>(COLLECTION);
  }

  async getDefault(orgId: OrgId = DEFAULT_ORG): Promise<OutreachVideoDocument | null> {
    return this.col.findOne({ _id: defaultDocKey(orgId) });
  }

  /** Upsert this org's default-video metadata. Returns the previous r2_key (if
   *  any) so the caller can delete the now-orphaned object from R2. */
  async setDefault(input: {
    r2_key: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    uploaded_by: string;
  }, orgId: OrgId = DEFAULT_ORG): Promise<string | null> {
    const previous = await this.getDefault(orgId);
    const doc: OutreachVideoDocument = {
      _id: defaultDocKey(orgId),
      r2_key: input.r2_key,
      filename: input.filename,
      mime_type: input.mime_type,
      size_bytes: input.size_bytes,
      uploaded_at: new Date(),
      uploaded_by: input.uploaded_by,
    };
    await this.col.replaceOne({ _id: doc._id }, doc, { upsert: true });
    return previous?.r2_key ?? null;
  }

  /** Remove this org's default-video metadata. Returns the removed r2_key (if
   *  any) so the caller can delete the object from R2. */
  async clearDefault(orgId: OrgId = DEFAULT_ORG): Promise<string | null> {
    const previous = await this.getDefault(orgId);
    if (!previous) return null;
    const res = await this.col.deleteOne({ _id: defaultDocKey(orgId) });
    if (res.deletedCount !== 1) {
      Logger.warn('outreach_media clearDefault: default doc vanished between read and delete');
    }
    return previous.r2_key;
  }

  /** List this org's extra (additional) default videos, oldest first. */
  async listExtras(orgId: OrgId = DEFAULT_ORG): Promise<OutreachExtraVideoDocument[]> {
    return this.extraCol.find({ org_id: orgId }).sort({ _id: 1 }).toArray();
  }

  async addExtra(input: {
    r2_key: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    uploaded_by: string;
  }, orgId: OrgId = DEFAULT_ORG): Promise<ObjectId> {
    const oid = new ObjectId();
    const doc: OutreachExtraVideoDocument = {
      _id: oid,
      org_id: orgId,
      r2_key: input.r2_key,
      filename: input.filename,
      mime_type: input.mime_type,
      size_bytes: input.size_bytes,
      uploaded_at: new Date(),
      uploaded_by: input.uploaded_by,
    };
    await this.extraCol.insertOne(doc);
    return oid;
  }

  /** Removes the metadata doc; returns the removed r2_key (caller deletes
   *  the R2 object) or null if no such extra existed. */
  async removeExtra(id: string | ObjectId): Promise<string | null> {
    try {
      const oid = typeof id === 'string' ? new ObjectId(id) : id;
      const doc = await this.extraCol.findOne({ _id: oid });
      if (!doc) return null;
      await this.extraCol.deleteOne({ _id: oid });
      return doc.r2_key;
    } catch {
      return null;
    }
  }

  async sumExtraBytes(orgId: OrgId = DEFAULT_ORG): Promise<number> {
    const docs = await this.extraCol.find({ org_id: orgId }).project({ size_bytes: 1 }).toArray();
    return docs.reduce((sum, d) => sum + (d.size_bytes || 0), 0);
  }
}
