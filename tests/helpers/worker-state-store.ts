/**
 * In-memory worker state, sufficient to exercise the Payment delivery
 * reservation guard.
 *
 * That guard is the one place the code compares two fields of the same document
 * ($expr with $add), so the double has to understand that shape — a fake that
 * ignored $expr would report the cap as working while it silently did nothing.
 */
import {
  OutreachWorkerStateRepository,
  WorkerStateCollectionPort,
  WorkerStateDocument,
  defaultState,
} from '../../src/outreach/outreach-worker-state-repository';

type Doc = Record<string, unknown>;

function evaluateExpr(expr: unknown, document: Doc): unknown {
  if (typeof expr === 'string' && expr.startsWith('$')) return document[expr.slice(1)];
  if (!expr || typeof expr !== 'object') return expr;
  const [op, operands] = Object.entries(expr as Record<string, unknown>)[0];
  const values = (operands as unknown[]).map((operand) => evaluateExpr(operand, document));
  switch (op) {
    case '$add':
      return values.reduce<number>((sum, value) => sum + (value as number), 0);
    case '$lt':
      return (values[0] as number) < (values[1] as number);
    case '$lte':
      return (values[0] as number) <= (values[1] as number);
    default:
      throw new Error(`unsupported $expr operator in test double: ${op}`);
  }
}

function matches(document: Doc, filter: Record<string, unknown>): boolean {
  for (const [field, expected] of Object.entries(filter)) {
    if (field === '$expr') {
      if (evaluateExpr(expected, document) !== true) return false;
      continue;
    }
    const actual = document[field];
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      for (const [op, operand] of Object.entries(expected as Record<string, unknown>)) {
        if (op === '$gt' && !((actual as number) > (operand as number))) return false;
        else if (op === '$ne' && actual === operand) return false;
        else if (op === '$lt' && !((actual as number) < (operand as number))) return false;
        else if (!['$gt', '$ne', '$lt'].includes(op)) {
          throw new Error(`unsupported operator in worker-state double: ${op}`);
        }
      }
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function applyUpdate(document: Doc, update: Record<string, unknown>): void {
  for (const [op, fields] of Object.entries(update)) {
    const payload = fields as Record<string, unknown>;
    if (op === '$set') Object.assign(document, payload);
    else if (op === '$setOnInsert') continue;
    else if (op === '$inc') {
      for (const [key, value] of Object.entries(payload)) {
        document[key] = ((document[key] as number) ?? 0) + (value as number);
      }
    } else throw new Error(`unsupported update operator in worker-state double: ${op}`);
  }
}

export class InMemoryWorkerStateStore implements WorkerStateCollectionPort {
  documents = new Map<string, Doc>();

  async findOne(filter: Record<string, unknown>): Promise<WorkerStateDocument | null> {
    for (const document of this.documents.values()) {
      if (matches(document, filter)) return document as unknown as WorkerStateDocument;
    }
    return null;
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean }
  ): Promise<void> {
    const id = filter._id as string;
    const existing = this.documents.get(id);
    if (!existing) {
      if (!options?.upsert) return;
      const seed = { ...(update.$setOnInsert as object) } as Doc;
      applyUpdate(seed, { ...update, $setOnInsert: {} });
      this.documents.set(id, seed);
      return;
    }
    if (!matches(existing, filter)) return;
    applyUpdate(existing, update);
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>
  ): Promise<WorkerStateDocument | null> {
    const id = filter._id as string;
    const existing = this.documents.get(id);
    if (!existing || !matches(existing, filter)) return null;
    applyUpdate(existing, update);
    return existing as unknown as WorkerStateDocument;
  }
}

/**
 * Worker state repository over an in-memory store, seeded with a given day's
 * counters. Exposes the live document so a test can read reservation counts
 * back without going through another repository call.
 */
export class InMemoryWorkerStateRepository extends OutreachWorkerStateRepository {
  readonly store = new InMemoryWorkerStateStore();

  constructor(
    initial: Partial<WorkerStateDocument>,
    private readonly now: () => Date,
    orgId = 'payment_tracker'
  ) {
    const store = new InMemoryWorkerStateStore();
    super(store);
    this.store = store;
    this.store.documents.set(orgId, {
      ...defaultState(orgId),
      // Pin the roll key to today so seeded counters are not reset on first use.
      claims_today_day: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Phnom_Penh' }).format(now()),
      ...initial,
    } as unknown as Doc);
  }

  private document(orgId = 'payment_tracker'): Doc {
    return this.store.documents.get(orgId) as Doc;
  }

  get delivery_reservations(): number {
    return this.document().delivery_reservations as number;
  }

  get deliveries_today(): number {
    return this.document().deliveries_today as number;
  }
}
