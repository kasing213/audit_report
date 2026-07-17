// src/outreach/outreach-video-repository.ts
/**
 * Stores METADATA for the single default marketing video — never the bytes.
 * The 50MB video lives in Cloudflare R2 (see R2StorageService); this repo holds
 * only the pointer (r2_key) plus display metadata, in the `outreach_media`
 * Mongo collection as one fixed doc `_id: 'default'`. Mirrors the shape of
 * OutreachImagesRepository minus the Binary `data` field.
 */
import { Collection } from 'mongodb';
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

const COLLECTION = 'outreach_media';

export class OutreachVideoRepository {
  private col: Collection<OutreachVideoDocument>;

  constructor() {
    const db = DatabaseConnection.getInstance().getDb();
    this.col = db.collection<OutreachVideoDocument>(COLLECTION);
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
}
