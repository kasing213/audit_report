import { Filter, MongoClient } from 'mongodb';
import { toInternationalPhone } from '../utils/phone-utils';
import type { SalesSyncCursor, SalesSyncSource } from './sync-service';

export const SALES_SOURCE_DB = process.env.LEAD_CONTROL_SALES_DATABASE_NAME || 'ar_tracker';
export const SALES_SOURCE_COLLECTION = process.env.LEAD_CONTROL_SALES_COLLECTION || 'sales';

const CONNECT_TIMEOUT_MS = 10_000;
const PHONE_E164 = /^\+855\d{8,9}$/;
const ALLOWED_ACTIONS = ['find', 'listIndexes'];

/** Untrusted document shape from the authoritative Payment Tracker sales collection. */
export interface RawSalesRecord {
  sale_id: unknown;
  status: unknown;
  phone: unknown;
  start_date?: unknown;
  booking_date?: unknown;
  completed_date?: unknown;
  cancelled_date?: unknown;
  updated_at: unknown;
}

export interface NormalizedSalesRecord {
  saleId: string;
  status: string;
  normalizedPhone: string;
  bookingDate: Date;
  completedDate: Date | null;
  cancelledDate: Date | null;
  updatedAt: Date;
}

export type SalesNormalizationResult =
  | { ok: true; sale: NormalizedSalesRecord }
  | { ok: false; saleId: string | null; reason: string };

export type PrivilegeCheck = { ok: true } | { ok: false; reason: string };

/**
 * Fails closed unless the credential has precisely collection-scoped read
 * capabilities. Database-wide read and every write/admin action are rejected.
 */
export function validateSalesSourcePrivileges(privileges: unknown): PrivilegeCheck {
  if (!Array.isArray(privileges) || privileges.length === 0) {
    return { ok: false, reason: 'no privileges reported for the sales source credential' };
  }

  const granted = new Set<string>();
  for (const entry of privileges) {
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'malformed privilege entry' };
    const { resource, actions } = entry as { resource?: unknown; actions?: unknown };
    if (!resource || typeof resource !== 'object') return { ok: false, reason: 'privilege entry has no resource' };
    const candidate = resource as { db?: unknown; collection?: unknown };
    if (candidate.db !== SALES_SOURCE_DB || candidate.collection !== SALES_SOURCE_COLLECTION) {
      return { ok: false, reason: `privilege must target ${SALES_SOURCE_DB}.${SALES_SOURCE_COLLECTION}` };
    }
    if (!Array.isArray(actions) || actions.length === 0) return { ok: false, reason: 'privilege entry grants no actions' };
    for (const action of actions) {
      if (typeof action !== 'string' || !ALLOWED_ACTIONS.includes(action)) {
        return { ok: false, reason: `disallowed action: ${String(action)}` };
      }
      granted.add(action);
    }
  }

  const missing = ALLOWED_ACTIONS.filter((action) => !granted.has(action));
  return missing.length === 0
    ? { ok: true }
    : { ok: false, reason: `missing required action(s): ${missing.join(', ')}` };
}

/** Normalize only source values that are unambiguous; malformed records never enter the projection. */
export function normalizeSalesRecord(raw: RawSalesRecord): SalesNormalizationResult {
  const saleId = nonEmptyString(raw.sale_id);
  if (!saleId) return { ok: false, saleId: null, reason: 'invalid_sale_id' };
  const status = nonEmptyString(raw.status);
  if (!status) return { ok: false, saleId, reason: 'invalid_status' };
  const normalizedPhone = normalizePhone(raw.phone);
  if (!normalizedPhone) return { ok: false, saleId, reason: 'no_valid_phone' };
  const bookingDate = readDate(raw.start_date ?? raw.booking_date);
  if (!bookingDate) return { ok: false, saleId, reason: 'invalid_booking_date' };
  const updatedAt = readDate(raw.updated_at);
  if (!updatedAt) return { ok: false, saleId, reason: 'invalid_updated_at' };
  const completedDate = nullableDate(raw.completed_date);
  if (completedDate === undefined) return { ok: false, saleId, reason: 'invalid_completed_date' };
  const cancelledDate = nullableDate(raw.cancelled_date);
  if (cancelledDate === undefined) return { ok: false, saleId, reason: 'invalid_cancelled_date' };

  return {
    ok: true,
    sale: {
      saleId,
      status: status.toUpperCase(),
      normalizedPhone,
      bookingDate,
      completedDate,
      cancelledDate,
      updatedAt,
    },
  };
}

/** A narrow, read-only collection contract. It deliberately exposes no write or index methods. */
export interface SalesReadCollection {
  find(
    filter: Record<string, unknown>,
    options: { projection: typeof SALES_PROJECTION; sort: { updated_at: 1; sale_id: 1 } },
  ): { toArray(): Promise<RawSalesRecord[]> };
}

export const SALES_PROJECTION = {
  _id: 0,
  sale_id: 1,
  status: 1,
  phone: 1,
  start_date: 1,
  booking_date: 1,
  completed_date: 1,
  cancelled_date: 1,
  updated_at: 1,
} as const;

/** Queries the source incrementally; source sort and filter make the cursor deterministic. */
export class PaymentSalesSourceRepository implements SalesSyncSource {
  constructor(private readonly collection: SalesReadCollection) {}

  async listSalesAfter(cursor: SalesSyncCursor | null): Promise<RawSalesRecord[]> {
    const filter: Record<string, unknown> = cursor === null
      ? { updated_at: { $exists: true } }
      : {
        $or: [
          { updated_at: { $gt: cursor.updatedAt } },
          { updated_at: cursor.updatedAt, sale_id: { $gt: cursor.saleId } },
        ],
      };
    return this.collection.find(filter, { projection: SALES_PROJECTION, sort: { updated_at: 1, sale_id: 1 } }).toArray();
  }
}

/** Dedicated, fail-closed connection to Payment Tracker's sales collection. */
export class PaymentSalesSourceConnection {
  private client: MongoClient | null = null;

  isConnected(): boolean { return this.client !== null; }

  async connect(): Promise<void> {
    if (this.client) return;
    const uri = process.env.LEAD_CONTROL_SALES_DATABASE_URL;
    if (!uri) throw new Error('LEAD_CONTROL_SALES_DATABASE_URL is not set');

    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
    });
    try {
      await client.connect();
      const status = await client.db(SALES_SOURCE_DB).command({ connectionStatus: 1, showPrivileges: true }) as Record<string, unknown>;
      const authInfo = (status.authInfo ?? {}) as Record<string, unknown>;
      const ruling = validateSalesSourcePrivileges(authInfo.authenticatedUserPrivileges);
      if (!ruling.ok) throw new Error(`sales source credential rejected: ${ruling.reason}`);
      this.client = client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    await client.close();
  }

  collection(): SalesReadCollection {
    const collection = this.requireClient().db(SALES_SOURCE_DB).collection<RawSalesRecord>(SALES_SOURCE_COLLECTION);
    return {
      find: (filter, options) => collection.find(filter as Filter<RawSalesRecord>, options),
    };
  }

  private requireClient(): MongoClient {
    if (!this.client) throw new Error('Sales source not connected. Call connect() first.');
    return this.client;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readDate(value: unknown): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

function nullableDate(value: unknown): Date | null | undefined {
  if (value === null || value === undefined) return null;
  return readDate(value) ?? undefined;
}

function normalizePhone(value: unknown): string | null {
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) continue;
    const normalized = toInternationalPhone(candidate.trim());
    if (PHONE_E164.test(normalized)) return normalized;
  }
  return null;
}
