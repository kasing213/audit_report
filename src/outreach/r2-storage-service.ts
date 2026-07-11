// src/outreach/r2-storage-service.ts
/**
 * R2StorageService — Cloudflare R2 (S3-compatible) object storage for the
 * outreach marketing video.
 *
 * TS port of D:\KS-outreach\app\services\r2_storage_service.py, trimmed for this
 * single-tenant internal tool: the bucket holds ONE default marketing video
 * (audit-sales sends the same video to every lead). The bucket stays private;
 * the local worker is handed a short-TTL presigned GET URL minted at claim time
 * (generatePresignedGet), downloads the bytes, and uploads them to Telegram.
 * The worker never holds R2 credentials — only the server does.
 *
 * Env vars: R2_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY, R2_BUCKET.
 */
import { randomUUID } from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Logger } from '../utils/logger';

// Content type → file extension for the object key. mp4 is the only type the
// upload endpoint accepts today; the map leaves room without being a promise.
const CONTENT_TYPE_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
};

function extFor(contentType: string): string {
  return CONTENT_TYPE_EXT[(contentType || '').toLowerCase()] || 'bin';
}

export class R2StorageService {
  private accountId = process.env.R2_ACCOUNT_ID || '';
  private accessKey = process.env.R2_ACCESS_KEY || '';
  private secretKey = process.env.R2_SECRET_KEY || '';
  private bucket = process.env.R2_BUCKET || '';
  private client: S3Client | null = null;

  isConfigured(): boolean {
    return Boolean(this.accountId && this.accessKey && this.secretKey && this.bucket);
  }

  private getClient(): S3Client {
    if (!this.isConfigured()) {
      throw new Error('R2 storage not configured. Set R2_ACCOUNT_ID / R2_ACCESS_KEY / R2_SECRET_KEY / R2_BUCKET.');
    }
    if (!this.client) {
      this.client = new S3Client({
        region: 'auto',
        endpoint: `https://${this.accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: this.accessKey, secretAccessKey: this.secretKey },
        forcePathStyle: true,
      });
    }
    return this.client;
  }

  /**
   * Upload the marketing video to R2 and return its object key. Key format:
   * `outreach-media/default-video-<uuid>.<ext>`. The key is what the metadata
   * doc stores; generatePresignedGet mints a GET URL from it at send time.
   */
  async uploadVideo(buffer: Buffer, contentType: string): Promise<string> {
    if (!this.isConfigured()) throw new Error('R2 storage not configured');
    const key = `outreach-media/default-video-${randomUUID()}.${extFor(contentType)}`;
    const client = this.getClient();
    await client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      Metadata: { uploaded_at: new Date().toISOString() },
    }));
    Logger.info(`R2 uploaded: bucket=${this.bucket} key=${key} bytes=${buffer.length}`);
    return key;
  }

  /**
   * Return a short-TTL presigned GET URL for a stored object. Signing is a local
   * operation (no network round trip). The worker fetches this URL and streams
   * the bytes to Telegram via gramjs sendFile.
   */
  async generatePresignedGet(key: string, expiresInSec = 300): Promise<string> {
    const client = this.getClient();
    return getSignedUrl(client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSec,
    });
  }

  /**
   * Delete an object, retrying transient failures up to 3 times. Best-effort:
   * used when replacing or clearing the default video. Returns true on success
   * (including a no-op delete of an already-gone key).
   */
  async deleteObject(key: string): Promise<boolean> {
    if (!this.isConfigured()) {
      Logger.warn(`R2 not configured, skipping delete: key=${key}`);
      return false;
    }
    const client = this.getClient();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
        return true;
      } catch (err) {
        if (attempt === 2) {
          Logger.error(`R2 delete failed after 3 attempts: key=${key}`, err as Error);
          return false;
        }
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); // 0.5s, 1.0s
      }
    }
    return false;
  }
}
