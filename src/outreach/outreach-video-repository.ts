// src/outreach/outreach-video-repository.ts
/**
 * Stores METADATA for this org's queued marketing videos — never the bytes.
 * Each video's 50MB-or-less file lives in Cloudflare R2 (see R2StorageService);
 * this repo holds only the pointer (r2_key) plus display metadata, one Mongo
 * doc per video in the `outreach_media` collection. Org scoping follows the
 * same `org_id` + `orgMatch()` convention as OutreachSuppressionRepository
 * (absent/null org_id belongs to the default org).
 *
 * Budget: an org may queue at most MAX_VIDEO_COUNT videos, and their combined
 * size_bytes may not exceed MAX_TOTAL_VIDEO_BYTES. Both are enforced in add()
 * before the caller uploads bytes to R2 (caller checks first with a HEAD-style
 * dry validation, then calls add() as the authoritative check).
 */
import { Collection, ObjectId } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { Logger } from '../utils/logger';
import { OrgId, DEFAULT_ORG, orgMatch } from './orgs';

export interface OutreachVideoDocument {
  _id?: ObjectId;
  org_id?: string | null;
  r2_key: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: Date;
  uploaded_by: string;
}

export const MAX_VIDEO_COUNT = 5;
export const MAX_TOTAL_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB combined per org

export class VideoBudgetExceededError extends Error {
  constructor(
    public reason: 'count' | 'bytes',
    public currentCount: number,
    public currentBytes: number,
    public incomingBytes: number
  ) {
    const msg =
      reason === 'count'
        ? `Already at the ${MAX_VIDEO_COUNT}-video limit`
        : `Adding this ${(incomingBytes / (1024 * 1024)).toFixed(1)}MB video would exceed the ` +
          `${(MAX_TOTAL_VIDEO_BYTES / (1024 * 1024)).toFixed(0)}MB total ` +
          `(already using ${(currentBytes / (1024 * 1024)).toFixed(1)}MB)`;
    super(msg);
    this.name = 'VideoBudgetExceededError';
  }
}

const COLLECTION = 'outreach_media';

export class OutreachVideoRepository {
  private col: Collection<OutreachVideoDocument>;

  constructor() {
    const db = DatabaseConnection.getInstance().getDb();
    this.col = db.collection<OutreachVideoDocument>(COLLECTION);
  }

  /** All videos queued for this org, oldest first (= send order). */
  async listAll(orgId: OrgId = DEFAULT_ORG): Promise<OutreachVideoDocument[]> {
    return this.col.find({ org_id: orgMatch(orgId) }).sort({ uploaded_at: 1 }).toArray();
  }

  async getTotalBytes(orgId: OrgId = DEFAULT_ORG): Promise<number> {
    const videos = await this.listAll(orgId);
    return videos.reduce((sum, v) => sum + (v.size_bytes || 0), 0);
  }

  /**
   * Queue a new video for this org. Throws VideoBudgetExceededError (without
   * writing anything) if the count or combined-size budget would be breached.
   * Returns the inserted doc (with its generated _id).
   */
  async add(
    input: { r2_key: string; filename: string; mime_type: string; size_bytes: number; uploaded_by: string },
    orgId: OrgId = DEFAULT_ORG
  ): Promise<OutreachVideoDocument> {
    const existing = await this.listAll(orgId);
    if (existing.length >= MAX_VIDEO_COUNT) {
      const currentBytes = existing.reduce((sum, v) => sum + (v.size_bytes || 0), 0);
      throw new VideoBudgetExceededError('count', existing.length, currentBytes, input.size_bytes);
    }
    const currentBytes = existing.reduce((sum, v) => sum + (v.size_bytes || 0), 0);
    if (currentBytes + input.size_bytes > MAX_TOTAL_VIDEO_BYTES) {
      throw new VideoBudgetExceededError('bytes', existing.length, currentBytes, input.size_bytes);
    }
    const doc: OutreachVideoDocument = {
      org_id: orgId,
      r2_key: input.r2_key,
      filename: input.filename,
      mime_type: input.mime_type,
      size_bytes: input.size_bytes,
      uploaded_at: new Date(),
      uploaded_by: input.uploaded_by,
    };
    const res = await this.col.insertOne(doc);
    return { ...doc, _id: res.insertedId };
  }

  /** Remove one video by id (scoped to this org). Returns its r2_key so the
   *  caller can delete the R2 object, or null if not found / wrong org. */
  async remove(orgId: OrgId = DEFAULT_ORG, videoId: string): Promise<string | null> {
    let objectId: ObjectId;
    try {
      objectId = new ObjectId(videoId);
    } catch {
      return null;
    }
    const doc = await this.col.findOne({ _id: objectId, org_id: orgMatch(orgId) });
    if (!doc) return null;
    const res = await this.col.deleteOne({ _id: objectId });
    if (res.deletedCount !== 1) {
      Logger.warn(`outreach_media remove: doc ${videoId} vanished between read and delete`);
    }
    return doc.r2_key;
  }
}
