/**
 * Stores the Payment Tracker reminder wording and its approval state.
 *
 * One document, `_id: 'payment_tracker'`, in `payment_tracker_settings` on the
 * MAIN audit-sales database (never the source). Mirrors the shape of
 * OutreachSettingsRepository, with one addition that carries the whole safety
 * story: approval is a separate, explicit act, and editing the wording revokes
 * it. Scanning and Payment Auto are both gated on currently-approved wording,
 * so nobody can quietly change what customers are told about money they owe.
 */
import { Collection } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { assertSupportedPlaceholders, PaymentTemplateError } from './payment-template';

const COLLECTION = 'payment_tracker_settings';
const DOC_ID = 'payment_tracker';
const MAX_TEMPLATE_LENGTH = 4096;

export interface PaymentTemplateDocument {
  _id: 'payment_tracker';
  template_text: string;
  updated_at: Date;
  updated_by: string;
  approved_at: Date | null;
  approved_by: string | null;
}

/**
 * The two operations the repository needs, so it can be exercised without a
 * database. The real Mongo collection satisfies this structurally.
 */
export interface PaymentTemplateStore {
  findOne(): Promise<PaymentTemplateDocument | null>;
  replaceOne(filter: { _id: 'payment_tracker' }, document: PaymentTemplateDocument): Promise<void>;
}

/** True only when there is wording AND that exact wording is currently approved. */
export function isPaymentTemplateActive(document: PaymentTemplateDocument | null): boolean {
  return Boolean(document && document.template_text.trim().length > 0 && document.approved_at);
}

export class PaymentTemplateRepository {
  private readonly store: PaymentTemplateStore;
  private readonly now: () => Date;

  constructor(store?: PaymentTemplateStore, now: () => Date = () => new Date()) {
    this.store = store ?? defaultStore();
    this.now = now;
  }

  async get(): Promise<PaymentTemplateDocument | null> {
    return this.store.findOne();
  }

  /** Approved wording, or null when it is absent or its approval was revoked. */
  async getActiveText(): Promise<string | null> {
    const document = await this.get();
    return isPaymentTemplateActive(document) ? (document as PaymentTemplateDocument).template_text : null;
  }

  /**
   * Save wording as a draft. Always clears approval, even if the text is
   * unchanged in substance — re-approving is cheap, and an edit that silently
   * inherited an old approval is the failure this guards against.
   */
  async saveDraft(text: string, actor: string): Promise<PaymentTemplateDocument> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new PaymentTemplateError('payment wording is not configured');
    }
    if (trimmed.length > MAX_TEMPLATE_LENGTH) {
      throw new PaymentTemplateError(`payment wording exceeds ${MAX_TEMPLATE_LENGTH} characters`);
    }

    return this.write({
      template_text: trimmed,
      updated_at: this.now(),
      updated_by: actor,
      approved_at: null,
      approved_by: null,
    });
  }

  /** Record explicit human approval of the wording as it currently stands. */
  async approve(actor: string): Promise<PaymentTemplateDocument> {
    const existing = await this.get();
    const text = existing?.template_text.trim() ?? '';
    if (text.length === 0) {
      throw new PaymentTemplateError('payment wording is not configured');
    }
    assertSupportedPlaceholders(text);

    const now = this.now();
    return this.write({
      template_text: text,
      updated_at: existing?.updated_at ?? now,
      updated_by: existing?.updated_by ?? actor,
      approved_at: now,
      approved_by: actor,
    });
  }

  /**
   * Reset to empty and unapproved. Writes a document rather than deleting one
   * so the audit metadata (who cleared it, when) survives.
   */
  async clear(actor: string): Promise<PaymentTemplateDocument> {
    return this.write({
      template_text: '',
      updated_at: this.now(),
      updated_by: actor,
      approved_at: null,
      approved_by: null,
    });
  }

  private async write(fields: Omit<PaymentTemplateDocument, '_id'>): Promise<PaymentTemplateDocument> {
    const document: PaymentTemplateDocument = { _id: DOC_ID, ...fields };
    await this.store.replaceOne({ _id: DOC_ID }, document);
    return document;
  }
}

/** Mongo-backed store. Separated so the constructor stays injectable. */
function defaultStore(): PaymentTemplateStore {
  const col: Collection<PaymentTemplateDocument> = DatabaseConnection.getInstance()
    .getDb()
    .collection<PaymentTemplateDocument>(COLLECTION);

  return {
    findOne: () => col.findOne({ _id: DOC_ID }),
    replaceOne: async (filter, document) => {
      await col.replaceOne(filter, document, { upsert: true });
    },
  };
}
