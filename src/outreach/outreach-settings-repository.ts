/**
 * Stores operator-editable outreach settings as a single singleton doc
 * (`_id: 'default'`) in the `outreach_settings` collection. Currently holds
 * just the default static outreach message. Mirrors the singleton-doc shape of
 * OutreachVideoRepository.
 */
import { Collection } from 'mongodb';
import DatabaseConnection from '../database/connection';

export interface OutreachSettingsDocument {
  _id: 'default';
  static_message: string;
  updated_at: Date;
  updated_by: string;
}

const COLLECTION = 'outreach_settings';
const DEFAULT_ID = 'default';

export class OutreachSettingsRepository {
  private col: Collection<OutreachSettingsDocument>;

  constructor() {
    const db = DatabaseConnection.getInstance().getDb();
    this.col = db.collection<OutreachSettingsDocument>(COLLECTION);
  }

  /** The saved default message, or null if none has been set. */
  async getStaticMessage(): Promise<string | null> {
    const doc = await this.col.findOne({ _id: DEFAULT_ID } as any);
    return doc?.static_message ?? null;
  }

  /** Full settings doc, or null. Used by the API to surface updated_at/by. */
  async getDefaultDoc(): Promise<OutreachSettingsDocument | null> {
    return this.col.findOne({ _id: DEFAULT_ID } as any);
  }

  /** Upsert the default message. */
  async setStaticMessage(text: string, updatedBy: string): Promise<void> {
    const doc: OutreachSettingsDocument = {
      _id: DEFAULT_ID,
      static_message: text,
      updated_at: new Date(),
      updated_by: updatedBy,
    };
    await this.col.replaceOne({ _id: DEFAULT_ID } as any, doc, { upsert: true });
  }

  /** Remove the saved message so the effective text reverts to env/hardcoded. */
  async clearStaticMessage(): Promise<void> {
    // Deleting zero docs is a normal no-op (reset when no custom message was set).
    await this.col.deleteOne({ _id: DEFAULT_ID } as any);
  }
}
