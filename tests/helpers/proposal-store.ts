/**
 * In-memory stand-in for the outreach_proposals collection.
 *
 * Implements enough real Mongo semantics — operator matching, $set/$inc,
 * sorting, and the partial unique index on payment_dedupe_key — that the
 * repository's org-scoping filters are genuinely exercised rather than
 * bypassed. That is the whole point: these tests exist to prove a Payment
 * worker cannot reach a Company proposal, and a fake that ignored the filter
 * would prove nothing.
 */
import { ObjectId } from 'mongodb';
import {
  OutreachProposalDocument,
  OutreachRepository,
  OutreachStatus,
  ProposalCollectionPort,
  ProposalFindCursor,
  ProposalUpdateResult,
} from '../../src/outreach/outreach-repository';

/** Mongo treats a missing field and an explicit null as equal for `null` queries. */
function readPath(document: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[key];
  }, document);
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (expected instanceof ObjectId) return actual instanceof ObjectId && actual.equals(expected);
  if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
  if (expected === null) return actual === null || actual === undefined;
  return actual === expected;
}

function compare(actual: unknown, expected: unknown): number | null {
  const a = actual instanceof Date ? actual.getTime() : actual;
  const b = expected instanceof Date ? expected.getTime() : expected;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

function matchesOperators(actual: unknown, spec: Record<string, unknown>): boolean {
  for (const [op, expected] of Object.entries(spec)) {
    switch (op) {
      case '$in':
        if (!(expected as unknown[]).some((value) => valuesEqual(actual, value))) return false;
        break;
      case '$nin':
        if ((expected as unknown[]).some((value) => valuesEqual(actual, value))) return false;
        break;
      case '$ne':
        if (valuesEqual(actual, expected)) return false;
        break;
      case '$exists':
        if ((actual !== undefined) !== expected) return false;
        break;
      case '$type':
        if (expected === 'string' && typeof actual !== 'string') return false;
        break;
      case '$regex':
        if (typeof actual !== 'string' || !(expected as RegExp).test(actual)) return false;
        break;
      case '$lt':
      case '$lte':
      case '$gt':
      case '$gte': {
        const order = compare(actual, expected);
        if (order === null) return false;
        if (op === '$lt' && !(order < 0)) return false;
        if (op === '$lte' && !(order <= 0)) return false;
        if (op === '$gt' && !(order > 0)) return false;
        if (op === '$gte' && !(order >= 0)) return false;
        break;
      }
      default:
        throw new Error(`unsupported query operator in test double: ${op}`);
    }
  }
  return true;
}

function isOperatorSpec(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !(value instanceof ObjectId) &&
      !(value instanceof Date) &&
      !(value instanceof RegExp) &&
      !Array.isArray(value) &&
      Object.keys(value as object).every((key) => key.startsWith('$'))
  );
}

export function documentMatches(
  document: OutreachProposalDocument,
  filter: Record<string, unknown>
): boolean {
  for (const [field, expected] of Object.entries(filter)) {
    if (field === '$or') {
      if (!(expected as Array<Record<string, unknown>>).some((sub) => documentMatches(document, sub))) return false;
      continue;
    }
    if (field === '$and') {
      if (!(expected as Array<Record<string, unknown>>).every((sub) => documentMatches(document, sub))) return false;
      continue;
    }
    const actual = readPath(document as unknown as Record<string, unknown>, field);
    if (isOperatorSpec(expected)) {
      if (!matchesOperators(actual, expected)) return false;
    } else if (!valuesEqual(actual, expected)) {
      return false;
    }
  }
  return true;
}

function applyUpdate(document: Record<string, unknown>, update: Record<string, unknown>): boolean {
  let modified = false;
  for (const [op, fields] of Object.entries(update)) {
    const payload = fields as Record<string, unknown>;
    switch (op) {
      case '$set':
        for (const [key, value] of Object.entries(payload)) {
          if (!valuesEqual(document[key], value)) modified = true;
          document[key] = value;
        }
        break;
      case '$unset':
        for (const key of Object.keys(payload)) {
          if (key in document) modified = true;
          delete document[key];
        }
        break;
      case '$inc':
        for (const [key, value] of Object.entries(payload)) {
          document[key] = (typeof document[key] === 'number' ? (document[key] as number) : 0) + (value as number);
          modified = true;
        }
        break;
      case '$setOnInsert':
        break;
      default:
        throw new Error(`unsupported update operator in test double: ${op}`);
    }
  }
  return modified;
}

export class RecordingProposalCollection implements ProposalCollectionPort {
  documents: OutreachProposalDocument[] = [];
  lastFilter: Record<string, unknown> = {};

  async findOne(filter: Record<string, unknown>): Promise<OutreachProposalDocument | null> {
    this.lastFilter = filter;
    return this.documents.find((document) => documentMatches(document, filter)) ?? null;
  }

  find(filter: Record<string, unknown>): ProposalFindCursor {
    this.lastFilter = filter;
    let rows = this.documents.filter((document) => documentMatches(document, filter));
    const cursor: ProposalFindCursor = {
      sort(spec) {
        const [[field, direction]] = Object.entries(spec);
        rows = [...rows].sort((a, b) => {
          const order = compare(
            readPath(a as unknown as Record<string, unknown>, field),
            readPath(b as unknown as Record<string, unknown>, field)
          );
          return (order ?? 0) * direction;
        });
        return cursor;
      },
      limit(n) {
        rows = rows.slice(0, n);
        return cursor;
      },
      toArray: async () => rows,
    };
    return cursor;
  }

  async insertMany(documents: OutreachProposalDocument[]): Promise<number> {
    for (const document of documents) await this.insertOne(document);
    return documents.length;
  }

  async insertOne(document: OutreachProposalDocument): Promise<OutreachProposalDocument> {
    this.assertDedupeFree(document);
    const stored = { ...document, _id: document._id ?? new ObjectId() };
    this.documents.push(stored);
    return stored;
  }

  /**
   * Mirrors the partial unique index. Tests that expect upsertPaymentDraft to
   * report a losing insert need this to actually throw, not silently accept a
   * duplicate boundary.
   */
  protected assertDedupeFree(document: OutreachProposalDocument): void {
    const key = document.payment_dedupe_key;
    if (!key || document.type !== 'payment') return;
    if (this.documents.some((existing) => existing.payment_dedupe_key === key)) {
      const error: Error & { code?: number } = new Error('duplicate key payment_dedupe_unique');
      error.code = 11000;
      throw error;
    }
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean }
  ): Promise<ProposalUpdateResult> {
    this.lastFilter = filter;
    const target = this.documents.find((document) => documentMatches(document, filter));
    if (!target) {
      if (options?.upsert) {
        const seed = { ...(update.$setOnInsert as object), ...(update.$set as object) } as OutreachProposalDocument;
        await this.insertOne(seed);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    }
    const modified = applyUpdate(target as unknown as Record<string, unknown>, update);
    return { matchedCount: 1, modifiedCount: modified ? 1 : 0, upsertedCount: 0 };
  }

  async updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<ProposalUpdateResult> {
    this.lastFilter = filter;
    const targets = this.documents.filter((document) => documentMatches(document, filter));
    let modifiedCount = 0;
    for (const target of targets) {
      if (applyUpdate(target as unknown as Record<string, unknown>, update)) modifiedCount++;
    }
    return { matchedCount: targets.length, modifiedCount, upsertedCount: 0 };
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<OutreachProposalDocument | null> {
    this.lastFilter = filter;
    let candidates = this.documents.filter((document) => documentMatches(document, filter));
    const sort = options?.sort as Record<string, 1 | -1> | undefined;
    if (sort) {
      const [[field, direction]] = Object.entries(sort);
      candidates = [...candidates].sort((a, b) => {
        const order = compare(
          readPath(a as unknown as Record<string, unknown>, field),
          readPath(b as unknown as Record<string, unknown>, field)
        );
        return (order ?? 0) * direction;
      });
    }
    const target = candidates[0];
    if (!target) return null;
    const before = { ...target };
    applyUpdate(target as unknown as Record<string, unknown>, update);
    return options?.returnDocument === 'before' ? before : target;
  }

  async countDocuments(filter: Record<string, unknown>): Promise<number> {
    return this.documents.filter((document) => documentMatches(document, filter)).length;
  }

  async statusCounts(filter: Record<string, unknown>): Promise<Array<{ _id: OutreachStatus; count: number }>> {
    const tally = new Map<OutreachStatus, number>();
    for (const document of this.documents) {
      if (!documentMatches(document, filter)) continue;
      tally.set(document.status, (tally.get(document.status) ?? 0) + 1);
    }
    return [...tally].map(([status, count]) => ({ _id: status, count }));
  }

  async deleteMany(filter: Record<string, unknown>): Promise<number> {
    const keep = this.documents.filter((document) => !documentMatches(document, filter));
    const deleted = this.documents.length - keep.length;
    this.documents = keep;
    return deleted;
  }
}

export class InMemoryPaymentProposalStore extends RecordingProposalCollection {
  constructor(documents: OutreachProposalDocument[] = []) {
    super();
    // Backfill _id the way an insert would. A stored proposal always has one,
    // and without it every id-scoped filter silently misses.
    this.documents = documents.map((document) => ({
      ...structuredClone(document),
      _id: document._id ?? new ObjectId(),
    }));
  }

  async countByDedupeKey(key: string): Promise<number> {
    return this.documents.filter((document) => document.payment_dedupe_key === key).length;
  }
}

export function makeInMemoryProposalRepo(store = new InMemoryPaymentProposalStore()): OutreachRepository {
  return new OutreachRepository(store);
}
