/**
 * Stores operator-editable outreach settings, one doc PER ORG
 * (`_id: 'default:<org>'`) in the `outreach_settings` collection. Currently holds
 * just the per-org default static outreach message. Mirrors the shape of
 * OutreachVideoRepository.
 */
import { Collection } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { OrgId, DEFAULT_ORG, defaultDocKey } from './orgs';

export interface OutreachSettingsDocument {
  _id: string; // defaultDocKey(orgId), e.g. 'default:company'
  static_message: string;
  updated_at: Date;
  updated_by: string;
}

const COLLECTION = 'outreach_settings';

export class OutreachSettingsRepository {
  private col: Collection<OutreachSettingsDocument>;

  constructor() {
    const db = DatabaseConnection.getInstance().getDb();
    this.col = db.collection<OutreachSettingsDocument>(COLLECTION);
  }

  /** The saved default message for this org, or null if none has been set. */
  async getStaticMessage(orgId: OrgId = DEFAULT_ORG): Promise<string | null> {
    const doc = await this.col.findOne({ _id: defaultDocKey(orgId) });
    return doc?.static_message ?? null;
  }

  /** Full settings doc for this org, or null. Used by the API to surface updated_at/by. */
  async getDefaultDoc(orgId: OrgId = DEFAULT_ORG): Promise<OutreachSettingsDocument | null> {
    return this.col.findOne({ _id: defaultDocKey(orgId) });
  }

  /** Upsert this org's default message. */
  async setStaticMessage(text: string, updatedBy: string, orgId: OrgId = DEFAULT_ORG): Promise<void> {
    const doc: OutreachSettingsDocument = {
      _id: defaultDocKey(orgId),
      static_message: text,
      updated_at: new Date(),
      updated_by: updatedBy,
    };
    await this.col.replaceOne({ _id: doc._id }, doc, { upsert: true });
  }

  /** Remove this org's saved message so the effective text reverts to env/hardcoded. */
  async clearStaticMessage(orgId: OrgId = DEFAULT_ORG): Promise<void> {
    // Deleting zero docs is a normal no-op (reset when no custom message was set).
    await this.col.deleteOne({ _id: defaultDocKey(orgId) });
  }
}
