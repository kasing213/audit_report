# Payment Tracker Outreach Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-closed Payment Tracker workspace that reads `ar_tracker.ar_state` through a collection-scoped MongoDB credential, drafts grouped payment reminders, verifies every AR immediately before claim, and sends through an isolated Telegram worker.

**Architecture:** Keep Company and Personal on the existing sales path. Add focused `src/payment-tracker/` domain, source, proposal, scanner, and claim services; reuse the organization-scoped proposal/UI/worker infrastructure only after making ID-based worker operations strictly organization-scoped.

**Tech Stack:** TypeScript 5, Node.js 20+, Express, MongoDB Node driver 6, node-cron, Handlebars, GramJS/MTProto, PM2, Node's built-in `node:test` runner, ts-node.

**Spec:** `docs/superpowers/specs/2026-09-01-payment-tracker-integration-design.md`

## Global Constraints

- Never write, mirror, migrate, or create indexes in `ar_tracker.ar_state`.
- Accept only a source credential whose effective privileges are `find` and `listIndexes` on `ar_tracker.ar_state`; never copy the inspected `atlasAdmin` credential.
- Keep `PAYMENT_TRACKER_SCAN_ENABLED=false` by default and do not start a Payment worker during code deployment.
- Company and Personal remain the only workspaces processed by the existing sales scanner.
- Company/Personal session files, PM2 processes, schedules, caps, and MTProto behavior remain unchanged.
- Payment eligibility is limited to source `current_status` values `PENDING` and `OVERDUE`.
- Missing/malformed phone, money, credit, currency, date, source reads, and unknown status values fail closed.
- Deduplicate and suppress Payment reminders by exact `(payment_tracker, normalized_primary_phone, Cambodia due date)`.
- Require an explicit valid `X-Org-Id` on every agent request; never fall back to Company.
- Scope claim, proposal media, mark-sent, and mark-failed by both proposal ID and strict worker organization.
- Use test-first red/green cycles for every behavior change; preserve unrelated working-tree edits in `src/api/crm-routes.ts`, `src/api/import-parser.ts`, and `scripts/telegram-worker/worker.ts`.

---

### Task 1: Test harness and workspace boundary

**Files:**
- Create: `tsconfig.test.json`
- Create: `tests/all.test.ts`
- Create: `tests/payment-tracker/org-boundary.test.ts`
- Modify: `package.json`
- Modify: `src/outreach/orgs.ts`
- Modify: `src/outreach/org-context.ts`
- Modify: `src/scheduler/outreach-scheduler.ts:1-6,165-175,229-240`

**Interfaces:**
- Produces: `PAYMENT_TRACKER_ORG: OrgId`, `SALES_OUTREACH_ORGS: readonly OrgDef[]`, and `strictWorkerOrg(header: unknown): OrgId | null`.
- Preserves: `resolveOrg(req)` for browser/dashboard behavior.

- [ ] **Step 1: Add the test runner configuration**

Add this script to `package.json`:

```json
"test": "node --test -r ts-node/register tests/all.test.ts",
"test:payment": "node --test -r ts-node/register tests/all.test.ts"
```

Create `tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": ".", "noEmit": true },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

Create `tests/all.test.ts` with the first import:

```typescript
import './payment-tracker/org-boundary.test';
```

- [ ] **Step 2: Write the failing workspace-boundary tests**

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTREACH_ORGS,
  PAYMENT_TRACKER_ORG,
  SALES_OUTREACH_ORGS,
} from '../../src/outreach/orgs';
import { strictWorkerOrg } from '../../src/outreach/org-context';

test('navigation contains payment_tracker while sales scanner orgs do not', () => {
  assert.deepEqual(OUTREACH_ORGS.map((org) => org.id), ['company', 'personal', 'payment_tracker']);
  assert.equal(PAYMENT_TRACKER_ORG, 'payment_tracker');
  assert.deepEqual(SALES_OUTREACH_ORGS.map((org) => org.id), ['company', 'personal']);
});

test('strict worker org accepts only one registered header value', () => {
  assert.equal(strictWorkerOrg('company'), 'company');
  assert.equal(strictWorkerOrg('personal'), 'personal');
  assert.equal(strictWorkerOrg('payment_tracker'), 'payment_tracker');
  assert.equal(strictWorkerOrg(undefined), null);
  assert.equal(strictWorkerOrg(''), null);
  assert.equal(strictWorkerOrg('unknown'), null);
  assert.equal(strictWorkerOrg(['company']), null);
});
```

- [ ] **Step 3: Run the test and verify RED**

Run: `npm test`

Expected: compilation fails because `PAYMENT_TRACKER_ORG`, `SALES_OUTREACH_ORGS`, and `strictWorkerOrg` do not exist.

- [ ] **Step 4: Implement the explicit workspace registries**

In `src/outreach/orgs.ts`, define:

```typescript
export const PAYMENT_TRACKER_ORG: OrgId = 'payment_tracker';

export const SALES_OUTREACH_ORGS: readonly OrgDef[] = [
  { id: 'company', label: 'Company' },
  { id: 'personal', label: 'Personal' },
];

export const OUTREACH_ORGS: readonly OrgDef[] = [
  ...SALES_OUTREACH_ORGS,
  { id: PAYMENT_TRACKER_ORG, label: 'Payment Tracker' },
];
```

In `src/outreach/org-context.ts`, add:

```typescript
import { isValidOrg } from './orgs';

export function strictWorkerOrg(header: unknown): OrgId | null {
  return typeof header === 'string' && header.length > 0 && isValidOrg(header)
    ? header
    : null;
}
```

Replace both `OUTREACH_ORGS` loops in `OutreachScheduler` with `SALES_OUTREACH_ORGS` and update the import. Do not change scan timing, top-up logic, or `generateBatch`.

- [ ] **Step 5: Verify GREEN and type-check tests**

Run: `npm test`

Run: `npx tsc -p tsconfig.test.json`

Expected: both commands pass and the sales scanner test proves Payment is excluded.

- [ ] **Step 6: Commit the boundary**

```bash
git add package.json tsconfig.test.json tests/all.test.ts tests/payment-tracker/org-boundary.test.ts src/outreach/orgs.ts src/outreach/org-context.ts src/scheduler/outreach-scheduler.ts
git commit -m "feat(payment): add isolated workspace boundary"
```

---

### Task 2: Cambodia dates, AR validation, grouping, and fingerprints

**Files:**
- Create: `src/payment-tracker/payment-types.ts`
- Create: `src/payment-tracker/payment-domain.ts`
- Create: `tests/helpers/payment-fixtures.ts`
- Create: `tests/payment-tracker/payment-domain.test.ts`
- Modify: `tests/all.test.ts`

**Interfaces:**
- Produces: `RawPaymentAr`, `ValidatedPaymentAr`, `PaymentGroup`, `PaymentValidationResult`.
- Produces: `cambodiaDateKey(date)`, `cambodiaStartOfDate(dateKey)`, `endOfTomorrowCambodia(now)`, `validatePaymentAr(raw, cutoff)`, `groupPaymentArs(ars)`, `paymentDedupeKey(phone, dueDate)`, and `paymentFingerprint(group)`.
- Produces test helpers: `NOW`, `rawAr(overrides)`, and `paymentGroupFixture()` for every later Payment test.
- Consumes: `toInternationalPhone()` from `src/utils/phone-utils.ts`.

- [ ] **Step 1: Write failing domain tests**

Append the test import to `tests/all.test.ts`, then create tests with this fixture and assertions:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cambodiaDateKey,
  cambodiaStartOfDate,
  endOfTomorrowCambodia,
  groupPaymentArs,
  paymentDedupeKey,
  paymentFingerprint,
  validatePaymentAr,
} from '../../src/payment-tracker/payment-domain';
import { paymentGroupFixture, rawAr } from '../helpers/payment-fixtures';

test('Cambodia boundaries use local calendar dates', () => {
  const now = new Date('2026-09-03T16:59:59.000Z');
  assert.equal(cambodiaDateKey(now), '2026-09-03');
  assert.equal(cambodiaDateKey(new Date(now.getTime() + 1000)), '2026-09-04');
  assert.equal(cambodiaStartOfDate('2026-09-04').toISOString(), '2026-09-03T17:00:00.000Z');
  assert.equal(endOfTomorrowCambodia(now).toISOString(), '2026-09-04T16:59:59.999Z');
});

test('selects only the first valid normalized source phone', () => {
  const result = validatePaymentAr(rawAr(), new Date('2026-09-04T16:59:59.999Z'));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.ar.primaryPhone, '+85512345678');
});

test('validates currency before calculating a positive balance', () => {
  const valid = validatePaymentAr(rawAr(), new Date('2026-09-04T16:59:59.999Z'));
  assert.equal(valid.ok && valid.ar.amountDue, 100);
  for (const changed of [
    { credit_applied: null },
    { credit_applied: { value: 20, currency: 'KHR' } },
    { amount: { value: -1, currency: 'USD' } },
    { credit_applied: { value: Number.NaN, currency: 'USD' } },
    { current_status: 'PAID' },
    { current_status: 'UNKNOWN' },
  ]) {
    assert.equal(validatePaymentAr(rawAr(changed), new Date('2026-09-04T16:59:59.999Z')).ok, false);
  }
  assert.equal(validatePaymentAr(rawAr({ credit_applied: { value: 200, currency: 'USD' } }), new Date('2026-09-04T16:59:59.999Z')).ok, false);
});

test('groups by phone and exact due date and rejects mixed currency', () => {
  const cutoff = new Date('2026-09-04T16:59:59.999Z');
  const a = validatePaymentAr(rawAr({ ar_id: 'AR-2' }), cutoff);
  const b = validatePaymentAr(rawAr({ ar_id: 'AR-1', amount: { value: 80, currency: 'USD' }, credit_applied: { value: 5, currency: 'USD' } }), cutoff);
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  const grouped = groupPaymentArs([a.ar, b.ar]);
  assert.equal(grouped.groups.length, 1);
  assert.deepEqual(grouped.groups[0].arIds, ['AR-1', 'AR-2']);
  assert.equal(grouped.groups[0].balanceDue, 175);
  const khr = { ...b.ar, arId: 'AR-3', currency: 'KHR' };
  assert.equal(groupPaymentArs([a.ar, khr]).errors[0].code, 'mixed_currency');
});

test('fingerprint is order-independent and changes with every protected source field', () => {
  const cutoff = new Date('2026-09-04T16:59:59.999Z');
  const a = validatePaymentAr(rawAr({ ar_id: 'AR-2' }), cutoff);
  const b = validatePaymentAr(rawAr({ ar_id: 'AR-1' }), cutoff);
  assert.ok(a.ok && b.ok);
  if (!a.ok || !b.ok) return;
  const g1 = groupPaymentArs([a.ar, b.ar]).groups[0];
  const g2 = groupPaymentArs([b.ar, a.ar]).groups[0];
  assert.equal(paymentFingerprint(g1), paymentFingerprint(g2));
  assert.notEqual(paymentFingerprint(g1), paymentFingerprint({ ...g1, ars: g1.ars.map((item, i) => i ? item : { ...item, status: 'OVERDUE' }) }));
  assert.equal(paymentDedupeKey(g1.primaryPhone, g1.dueDate), 'payment_tracker|+85512345678|2026-09-04');
});
```

- [ ] **Step 2: Run the domain tests and verify RED**

Run: `npm test`

Expected: module-not-found errors for `payment-domain` and `payment-types`.

- [ ] **Step 3: Define the source and validated types**

Implement these public shapes in `payment-types.ts`:

```typescript
export interface RawPaymentAr {
  ar_id?: unknown;
  home_id?: unknown;
  customer_name?: unknown;
  customer_phone?: unknown;
  current_status?: unknown;
  amount?: unknown;
  credit_applied?: unknown;
  due_date?: unknown;
}

export interface ValidatedPaymentAr {
  arId: string;
  homeId: string | null;
  customerName: string | null;
  primaryPhone: string;
  status: 'PENDING' | 'OVERDUE';
  amountValue: number;
  creditValue: number;
  amountDue: number;
  currency: string;
  dueDate: string;
  sendNotBefore: Date;
  billingMonth: string;
}

export interface PaymentGroup {
  primaryPhone: string;
  dueDate: string;
  billingMonth: string;
  currency: string;
  amountTotal: number;
  creditTotal: number;
  balanceDue: number;
  arIds: string[];
  homeReferences: string[];
  customerNames: string[];
  ars: ValidatedPaymentAr[];
  sendNotBefore: Date;
}

export type PaymentValidationResult =
  | { ok: true; ar: ValidatedPaymentAr }
  | { ok: false; code: string; arId: string | null };
```

- [ ] **Step 4: Implement strict normalization and canonical hashing**

In `payment-domain.ts`, use a fixed Cambodia UTC+7 offset for midnight conversion, `Intl.DateTimeFormat(..., { timeZone: 'Asia/Phnom_Penh' })` for date keys, `^\+855\d{8,9}$` after `toInternationalPhone`, uppercase currencies, sorted AR entries, `JSON.stringify` with explicitly constructed field order, and `createHash('sha256')`.

Do not round or format monetary numbers in domain math. Use numeric values exactly as read and let the template formatter handle display.

Create `tests/helpers/payment-fixtures.ts` with this deterministic base fixture; later tasks extend only through the `overrides` argument:

```typescript
import { PaymentGroup, RawPaymentAr } from '../../src/payment-tracker/payment-types';
import { groupPaymentArs, validatePaymentAr } from '../../src/payment-tracker/payment-domain';

export const NOW = new Date('2026-09-03T17:00:00.000Z');
export const CUTOFF = new Date('2026-09-04T16:59:59.999Z');

export function rawAr(overrides: Partial<Record<keyof RawPaymentAr, unknown>> = {}): RawPaymentAr {
  return {
    ar_id: 'AR-2',
    home_id: 'H-2',
    customer_name: 'Sokha',
    customer_phone: ['invalid', '012 345 678', '099999999'],
    current_status: 'PENDING',
    amount: { value: 120, currency: 'usd' },
    credit_applied: { value: 20, currency: 'USD' },
    due_date: new Date('2026-09-04T00:00:00.000Z'),
    ...overrides,
  };
}

export function paymentGroupFixture(): PaymentGroup {
  const first = validatePaymentAr(rawAr({ ar_id: 'AR-2', home_id: 'H-2', customer_name: 'Dara' }), CUTOFF);
  const second = validatePaymentAr(rawAr({ ar_id: 'AR-1', home_id: 'H-1', customer_name: 'Sokha', amount: { value: 80, currency: 'USD' }, credit_applied: { value: 5, currency: 'USD' } }), CUTOFF);
  if (!first.ok || !second.ok) throw new Error('invalid payment fixture');
  return groupPaymentArs([first.ar, second.ar]).groups[0];
}
```

- [ ] **Step 5: Verify GREEN**

Run: `npm test`

Run: `npx tsc -p tsconfig.test.json`

Expected: all date, phone, money, grouping, and fingerprint tests pass.

- [ ] **Step 6: Commit the domain layer**

```bash
git add src/payment-tracker/payment-types.ts src/payment-tracker/payment-domain.ts tests/helpers/payment-fixtures.ts tests/payment-tracker/payment-domain.test.ts tests/all.test.ts
git commit -m "feat(payment): validate and group receivables"
```

---

### Task 3: Collection-scoped source client and query repository

**Files:**
- Create: `src/payment-tracker/payment-source-connection.ts`
- Create: `src/payment-tracker/payment-source-repository.ts`
- Create: `src/payment-tracker/payment-source-inspection.ts`
- Create: `tests/helpers/recording-collections.ts`
- Create: `tests/payment-tracker/payment-source.test.ts`
- Modify: `tests/all.test.ts`

**Interfaces:**
- Produces: `PaymentArSource` with `findCandidates(cutoff)`, `findByArIds(arIds)`, and `findCandidatesForDate(localDate)`.
- Produces: `PaymentSourceConnection.connect()`, `.collection()`, `.disconnect()`.
- Produces: `validateSourcePrivileges(privileges)` and `inspectPaymentSource()` using only `connectionStatus`, `find`, `listIndexes`, and `explain`.
- Produces test fake: `RecordingPaymentCollection` with `lastFilter`, `lastProjection`, and an array-backed `find()` cursor.

- [ ] **Step 1: Write failing source repository tests**

Use a recording fake collection and assert these exact filters/projections:

```typescript
test('candidate query uses current_status, BSON cutoff, phone presence, and a strict projection', async () => {
  const fake = new RecordingPaymentCollection([]);
  const repo = new PaymentSourceRepository(fake);
  const cutoff = new Date('2026-09-04T16:59:59.999Z');
  await repo.findCandidates(cutoff);
  assert.deepEqual(fake.lastFilter, {
    current_status: { $in: ['PENDING', 'OVERDUE'] },
    due_date: { $lte: cutoff },
    'customer_phone.0': { $exists: true },
  });
  assert.deepEqual(Object.keys(fake.lastProjection).sort(), [
    '_id', 'amount', 'ar_id', 'credit_applied', 'current_status',
    'customer_name', 'customer_phone', 'due_date', 'home_id',
  ]);
  assert.equal(fake.lastProjection._id, 0);
});

test('live lookup reads every referenced id regardless of status', async () => {
  const fake = new RecordingPaymentCollection([]);
  await new PaymentSourceRepository(fake).findByArIds(['AR-2', 'AR-1']);
  assert.deepEqual(fake.lastFilter, { ar_id: { $in: ['AR-1', 'AR-2'] } });
});

test('exact-date membership query uses Cambodia UTC bounds', async () => {
  const fake = new RecordingPaymentCollection([]);
  await new PaymentSourceRepository(fake).findCandidatesForDate('2026-09-04');
  assert.deepEqual(fake.lastFilter.due_date, {
    $gte: new Date('2026-09-03T17:00:00.000Z'),
    $lt: new Date('2026-09-04T17:00:00.000Z'),
  });
});

test('source privilege validation accepts only ar_state find and listIndexes', () => {
  const allowed = [
    { resource: { db: 'ar_tracker', collection: 'ar_state' }, actions: ['find', 'listIndexes'] },
  ];
  assert.equal(validateSourcePrivileges(allowed).ok, true);
  assert.equal(validateSourcePrivileges([{ resource: { db: 'ar_tracker', collection: '' }, actions: ['find'] }]).ok, false);
  assert.equal(validateSourcePrivileges([{ resource: { db: 'ar_tracker', collection: 'ar_state' }, actions: ['find', 'insert'] }]).ok, false);
  assert.equal(validateSourcePrivileges([{ resource: { db: 'admin', collection: '' }, actions: ['anyAction'] }]).ok, false);
});
```

Create the narrow production/test collection contract and fake with these members:

```typescript
export interface PaymentFindCursor {
  toArray(): Promise<RawPaymentAr[]>;
}

export interface PaymentReadCollection {
  find(filter: Record<string, unknown>, options: { projection: typeof PAYMENT_AR_PROJECTION }): PaymentFindCursor;
}

export class RecordingPaymentCollection implements PaymentReadCollection {
  lastFilter: Record<string, unknown> = {};
  lastProjection: Record<string, 0 | 1> = {};

  constructor(private readonly rows: RawPaymentAr[]) {}

  find(filter: Record<string, unknown>, options: { projection: Record<string, 0 | 1> }): PaymentFindCursor {
    this.lastFilter = filter;
    this.lastProjection = options.projection;
    return { toArray: async () => this.rows };
  }
}
```

Keep inspection's richer `listIndexes()`/`find().explain()` contract separate from `PaymentReadCollection`; candidate reads must not receive write-capable database objects.

- [ ] **Step 2: Run and verify RED**

Run: `npm test`

Expected: source modules and fake query interfaces are missing.

- [ ] **Step 3: Implement the separate connection**

`PaymentSourceConnection` must read only `PAYMENT_TRACKER_DATABASE_URL`, instantiate its own `MongoClient`, select `client.db('ar_tracker').collection<RawPaymentAr>('ar_state')`, and never expose a generic `Db`. Use 10-second connect/server-selection timeouts. Missing configuration throws `PAYMENT_TRACKER_DATABASE_URL is not set`.

The class contains no write method and no `createIndex` call.

- [ ] **Step 4: Implement the three projected reads and inspection**

Create a shared projection constant:

```typescript
export const PAYMENT_AR_PROJECTION = {
  _id: 0,
  ar_id: 1,
  home_id: 1,
  customer_name: 1,
  customer_phone: 1,
  current_status: 1,
  amount: 1,
  credit_applied: 1,
  due_date: 1,
} as const;
```

`inspectPaymentSource()` must use `connectionStatus: 1, showPrivileges: true`, `listIndexes()`, and the production candidate query's `explain('executionStats')`. Return redacted role/privilege, field-type, index-name, winning-plan, keys/docs examined, and readiness counts; never return the URI, phone values, names, home IDs, or AR IDs.

- [ ] **Step 5: Verify GREEN and scan for forbidden source writes**

Run: `npm test`

Run: `npx tsc -p tsconfig.test.json`

Run: `rg -n "insert|update|delete|replace|bulkWrite|createIndex" src/payment-tracker/payment-source-*.ts`

Expected: tests pass; the final scan has no Mongo write or index-creation calls. Words appearing in error text must not name callable write methods.

- [ ] **Step 6: Commit the source boundary**

```bash
git add src/payment-tracker/payment-source-connection.ts src/payment-tracker/payment-source-repository.ts src/payment-tracker/payment-source-inspection.ts tests/helpers/recording-collections.ts tests/payment-tracker/payment-source.test.ts tests/all.test.ts
git commit -m "feat(payment): add read-only AR source client"
```

---

### Task 4: Payment template approval and deterministic rendering

**Files:**
- Create: `src/payment-tracker/payment-template-repository.ts`
- Create: `src/payment-tracker/payment-template.ts`
- Create: `tests/payment-tracker/payment-template.test.ts`
- Modify: `tests/helpers/payment-fixtures.ts`
- Modify: `tests/all.test.ts`

**Interfaces:**
- Produces: `PaymentTemplateDocument`, `PaymentTemplateRepository.get()`, `.saveDraft(text, actor)`, `.approve(actor)`, `.clear(actor)`.
- Produces: `renderPaymentTemplate(text, group)` and `isPaymentTemplateActive(document)`.
- Defines: `PaymentTemplateStore` with `findOne()` and `replaceOne()` so the repository is testable without a database.

- [ ] **Step 1: Write failing template tests**

```typescript
test('saving edited wording clears approval', async () => {
  const store = new InMemoryPaymentTemplateStore();
  const repo = new PaymentTemplateRepository(store, () => new Date('2026-09-03T00:00:00Z'));
  await repo.saveDraft('Pay {{amount_due}} {{currency}} by {{due_date}}', 'developer');
  await repo.approve('developer');
  await repo.saveDraft('Updated {{ar_references}}', 'manager');
  const doc = await repo.get();
  assert.equal(doc?.approved_at, null);
  assert.equal(doc?.approved_by, null);
});

test('approval requires non-empty wording with only supported placeholders', async () => {
  const repo = makeTemplateRepo();
  await assert.rejects(() => repo.approve('developer'), /wording is not configured/);
  await repo.saveDraft('Hello {{unknown}}', 'developer');
  await assert.rejects(() => repo.approve('developer'), /unsupported placeholder: unknown/);
});

test('renderer substitutes deterministic source-backed fields', () => {
  const message = renderPaymentTemplate(
    '{{customer_names}} | {{ar_references}} | {{home_references}} | {{amount_due}} {{currency}} | {{due_date}}',
    paymentGroupFixture(),
  );
  assert.equal(message, 'Sokha / Dara | AR-1, AR-2 | H-1, H-2 | 175 USD | 2026-09-04');
});
```

Define the local test store used above in `payment-template.test.ts`:

```typescript
class InMemoryPaymentTemplateStore implements PaymentTemplateStore {
  document: PaymentTemplateDocument | null = null;
  async findOne(): Promise<PaymentTemplateDocument | null> { return this.document; }
  async replaceOne(_filter: { _id: 'payment_tracker' }, document: PaymentTemplateDocument): Promise<void> {
    this.document = structuredClone(document);
  }
}

function makeTemplateRepo(): PaymentTemplateRepository {
  return new PaymentTemplateRepository(
    new InMemoryPaymentTemplateStore(),
    () => new Date('2026-09-03T00:00:00.000Z'),
  );
}

export function approvedTemplateFixture(approved: boolean): PaymentTemplateDocument {
  return {
    _id: 'payment_tracker',
    template_text: 'Pay {{amount_due}} {{currency}} by {{due_date}} for {{ar_references}}',
    updated_at: new Date('2026-09-03T00:00:00.000Z'),
    updated_by: 'developer',
    approved_at: approved ? new Date('2026-09-03T00:01:00.000Z') : null,
    approved_by: approved ? 'developer' : null,
  };
}
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test`

Expected: template modules are missing.

- [ ] **Step 3: Implement the settings document and approval transition**

Store one main-database document with `_id: 'payment_tracker'` in `payment_tracker_settings`:

```typescript
export interface PaymentTemplateDocument {
  _id: 'payment_tracker';
  template_text: string;
  updated_at: Date;
  updated_by: string;
  approved_at: Date | null;
  approved_by: string | null;
}
```

Use `replaceOne({ _id: 'payment_tracker' }, document, { upsert: true })`. `saveDraft` trims text, enforces 1–4096 characters, and clears approval. `approve` validates current text and sets approval metadata. `clear` writes an empty, unapproved document so the audit metadata remains visible.

- [ ] **Step 4: Implement exact placeholder rendering**

Support only `customer_name`, `customer_names`, `ar_references`, `home_references`, `amount_due`, `currency`, and `due_date`. Sort/de-duplicate lists in the domain layer. Format `amount_due` using a non-grouped decimal string that preserves the exact numeric value; do not convert currencies or calculate a new amount.

- [ ] **Step 5: Verify GREEN**

Run: `npm test`

Run: `npx tsc -p tsconfig.test.json`

- [ ] **Step 6: Commit template behavior**

```bash
git add src/payment-tracker/payment-template-repository.ts src/payment-tracker/payment-template.ts tests/helpers/payment-fixtures.ts tests/payment-tracker/payment-template.test.ts tests/all.test.ts
git commit -m "feat(payment): require approved reminder wording"
```

---

### Task 5: Payment proposal persistence, dedupe, cancellation, and organization scoping

**Files:**
- Modify: `src/outreach/outreach-repository.ts`
- Create: `src/payment-tracker/payment-proposal-mapper.ts`
- Create: `tests/helpers/proposal-store.ts`
- Create: `tests/payment-tracker/payment-proposal.test.ts`
- Modify: `tests/all.test.ts`
- Modify: `src/api/outreach-routes.ts:812-940`

**Interfaces:**
- Extends: `OutreachStatus` with `cancelled` and `OutreachProposalDocument` with the optional Payment fields from the spec.
- Changes: all ID methods to take `orgId`: `getById(id, orgId)`, `updateMessage(id, orgId, message)`, `approve(id, orgId, actor)`, `skip(id, orgId, reason)`, `markSent(id, orgId)`, `markFailed(id, orgId, reason)`, `setCustomImage(id, orgId, imageId)`, `clearCustomImage(id, orgId)`.
- Produces: `upsertPaymentDraft(input)`, `cancelPayment(id, orgId, reason, actor)`, and payment verification-lease methods used in Task 7.
- Produces test fakes: `RecordingProposalCollection` for filter assertions and `InMemoryPaymentProposalStore` for dedupe behavior.

- [ ] **Step 1: Write failing repository/filter tests**

Use an injected recording collection and assert:

```typescript
test('every ID lookup and mutation includes proposal id and exact worker org', async () => {
  const collection = new RecordingProposalCollection();
  const repo = new OutreachRepository(collection);
  await repo.getById(PROPOSAL_ID, 'payment_tracker');
  assert.deepEqual(collection.lastFilter, { _id: new ObjectId(PROPOSAL_ID), org_id: 'payment_tracker' });
  await repo.markFailed(PROPOSAL_ID, 'payment_tracker', 'privacy');
  assert.deepEqual(collection.lastFilter, { _id: new ObjectId(PROPOSAL_ID), org_id: 'payment_tracker' });
});

test('legacy company lookup retains company compatibility match', async () => {
  const collection = new RecordingProposalCollection();
  await new OutreachRepository(collection).getById(PROPOSAL_ID, 'company');
  assert.deepEqual(collection.lastFilter, {
    _id: new ObjectId(PROPOSAL_ID),
    org_id: { $in: [null, 'company'] },
  });
});

test('payment proposal maps the complete audited source snapshot', () => {
  const document = mapPaymentProposal(paymentGroupFixture(), 'message', false, NOW);
  assert.equal(document.type, 'payment');
  assert.equal(document.org_id, 'payment_tracker');
  assert.deepEqual(document.referenced_ar_ids, ['AR-1', 'AR-2']);
  assert.equal(document.payment_dedupe_key, 'payment_tracker|+85512345678|2026-09-04');
  assert.equal(document.source_fingerprint, paymentFingerprint(paymentGroupFixture()));
  assert.equal(document.status, 'pending');
  assert.equal(document.verification_state, 'not_verified');
  assert.equal(document.send_not_before?.toISOString(), '2026-09-03T17:00:00.000Z');
});

test('same payment phone and due date cannot be inserted twice', async () => {
  const repo = makeInMemoryProposalRepo();
  assert.equal((await repo.upsertPaymentDraft(paymentDraftInput())).created, true);
  assert.equal((await repo.upsertPaymentDraft(paymentDraftInput())).created, false);
  assert.equal(await repo.countByDedupeKey('payment_tracker|+85512345678|2026-09-04'), 1);
});

test('Payment rejection is an auditable cancellation that retains its dedupe boundary', async () => {
  const repo = makeInMemoryProposalRepo();
  const created = await repo.upsertPaymentDraft(paymentDraftInput());
  await repo.cancelPayment(String(created.proposal?._id), 'payment_tracker', 'operator rejected', 'manager');
  const cancelled = await repo.getById(String(created.proposal?._id), 'payment_tracker');
  assert.equal(cancelled?.status, 'cancelled');
  assert.equal(cancelled?.cancelled_reason, 'operator rejected');
  assert.equal(cancelled?.cancelled_by, 'manager');
  assert.equal(cancelled?.payment_dedupe_key, 'payment_tracker|+85512345678|2026-09-04');
});

function paymentDraftInput() {
  return {
    document: mapPaymentProposal(paymentGroupFixture(), 'message', false, NOW),
    group: paymentGroupFixture(),
  };
}
```

`tests/helpers/proposal-store.ts` implements the narrow `ProposalCollectionPort` exported by `outreach-repository.ts`. Its `findOne`, `updateOne`, and `findOneAndUpdate` methods record the supplied filter and apply `$set`, `$setOnInsert`, and `$inc` to an array of documents. `InMemoryPaymentProposalStore` enforces one document per non-null `payment_dedupe_key` and returns `created: false` on a repeated key. The fake throws `duplicate key payment_dedupe_unique` if a test attempts a second physical insert, mirroring Mongo's partial unique index.

Use these exact fake members in tests:

```typescript
export class RecordingProposalCollection implements ProposalCollectionPort {
  documents: OutreachProposalDocument[] = [];
  lastFilter: Record<string, unknown> = {};
  async findOne(filter: Record<string, unknown>): Promise<OutreachProposalDocument | null>;
  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: { upsert?: boolean }): Promise<{ matchedCount: number; modifiedCount: number; upsertedCount: number }>;
  async findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>): Promise<OutreachProposalDocument | null>;
}

export class InMemoryPaymentProposalStore extends RecordingProposalCollection {
  constructor(documents: OutreachProposalDocument[] = []) {
    super();
    this.documents = structuredClone(documents);
  }
  async countByDedupeKey(key: string): Promise<number> {
    return this.documents.filter((document) => document.payment_dedupe_key === key).length;
  }
}

export function makeInMemoryProposalRepo(): OutreachRepository {
  return new OutreachRepository(new InMemoryPaymentProposalStore());
}
```

Implement the declared methods with real array matching for `_id`, `org_id`, `status`, and `payment_dedupe_key`; do not use casts that bypass those filters.

- [ ] **Step 2: Run and verify RED**

Run: `npm test`

Expected: signatures, payment fields, mapper, and `cancelled` status are absent.

- [ ] **Step 3: Extend the proposal model and add the partial unique index**

Add all spec fields with exact optional types. Add this index beside existing proposal indexes:

```typescript
{
  key: { payment_dedupe_key: 1 },
  name: 'payment_dedupe_unique',
  unique: true,
  partialFilterExpression: { type: 'payment', payment_dedupe_key: { $type: 'string' } },
}
```

Catch duplicate-key errors in `upsertPaymentDraft` and return `{ created: false, proposal }`; never delete a terminal proposal to make room.

- [ ] **Step 4: Scope all ID operations and update browser call sites**

Every method filter uses `{ _id, org_id: orgMatch(orgId) }`. In the dashboard routes, call `resolveOrg(req)` and pass the result. Scope `deleteAll` to an organization as well. Do not use a proposal's stored org until after a request-scoped lookup succeeds.

For Payment `/:id/skip`, call `cancelPayment(id, orgId, reason, actor)`; keep legacy `skip` for Company/Personal.

- [ ] **Step 5: Verify GREEN and compile every updated caller**

Run: `npm test`

Run: `npm run typecheck`

Run: `rg -n "getById\([^,]+\)|markSent\([^,]+\)|markFailed\([^,]+,[^,]+\)|setCustomImage\([^,]+,[^,]+\)|clearCustomImage\([^,]+\)" src`

Expected: tests and typecheck pass; the call-site scan finds no old unscoped signatures.

- [ ] **Step 6: Commit proposal safety**

```bash
git add src/outreach/outreach-repository.ts src/payment-tracker/payment-proposal-mapper.ts src/api/outreach-routes.ts tests/helpers/proposal-store.ts tests/payment-tracker/payment-proposal.test.ts tests/all.test.ts
git commit -m "feat(payment): persist deduplicated audited proposals"
```

---

### Task 6: Manual/Auto scanning and health state

**Files:**
- Create: `src/payment-tracker/payment-scan-state-repository.ts`
- Create: `src/payment-tracker/payment-scanner.ts`
- Create: `src/scheduler/payment-tracker-scheduler.ts`
- Create: `tests/payment-tracker/payment-scanner.test.ts`
- Modify: `tests/all.test.ts`

**Interfaces:**
- Produces: `PaymentTrackerScanner.run(now): Promise<PaymentScanResult>`.
- Produces: `PaymentTrackerScheduler.startScheduler()` and `.triggerNow()`.
- Consumes: `PaymentArSource`, domain validation/grouping, `PaymentTemplateRepository`, `OutreachRepository`, and Payment worker state.
- Defines test factory: `scannerDeps(options)` returning array-backed `source`, `proposals`, `health`, `template`, and `workerState` ports.

- [ ] **Step 1: Write failing scanner tests with dependency fakes**

Cover these exact outcomes:

```typescript
test('manual scan creates one pending draft for ARs sharing phone and due date', async () => {
  const deps = scannerDeps({ sourceRows: [rawAr({ ar_id: 'AR-1' }), rawAr({ ar_id: 'AR-2' })], autoApprove: false, templateApproved: true });
  const result = await new PaymentTrackerScanner(deps).run(NOW);
  assert.equal(result.created, 1);
  assert.equal(deps.proposals.documents[0].status, 'pending');
  assert.deepEqual(deps.proposals.documents[0].referenced_ar_ids, ['AR-1', 'AR-2']);
});

test('auto scan creates approved drafts only after wording approval', async () => {
  const enabled = scannerDeps({ sourceRows: [rawAr({ ar_id: 'AR-1' })], autoApprove: true, templateApproved: true });
  await new PaymentTrackerScanner(enabled).run(NOW);
  assert.equal(enabled.proposals.documents[0].status, 'approved');
  const blocked = scannerDeps({ sourceRows: [rawAr({ ar_id: 'AR-1' })], autoApprove: true, templateApproved: false });
  await assert.rejects(() => new PaymentTrackerScanner(blocked).run(NOW), /approved payment wording required/);
  assert.equal(blocked.proposals.documents.length, 0);
});

test('source outage writes no proposals and records a safe health error', async () => {
  const deps = scannerDeps({ sourceError: new Error('connection failed'), templateApproved: true });
  await assert.rejects(() => new PaymentTrackerScanner(deps).run(NOW), /connection failed/);
  assert.equal(deps.proposals.documents.length, 0);
  assert.equal(deps.health.last_error_code, 'source_unavailable');
});

test('invalid AR and mixed-currency group fail closed without blocking an unrelated valid group', async () => {
  const deps = scannerDeps({ sourceRows: [invalidCreditAr(), usdAr(), khrArSameKey(), validOtherPhoneAr()], templateApproved: true });
  const result = await new PaymentTrackerScanner(deps).run(NOW);
  assert.equal(result.created, 1);
  assert.equal(result.invalid_records, 1);
  assert.equal(result.blocked_groups, 1);
});
```

Define the fixture aliases and dependency factory locally in `payment-scanner.test.ts`:

```typescript
const invalidCreditAr = () => rawAr({ ar_id: 'BAD-CREDIT', credit_applied: null });
const usdAr = () => rawAr({ ar_id: 'USD-1', customer_phone: ['012345678'] });
const khrArSameKey = () => rawAr({ ar_id: 'KHR-1', customer_phone: ['012345678'], amount: { value: 400000, currency: 'KHR' }, credit_applied: { value: 0, currency: 'KHR' } });
const validOtherPhoneAr = () => rawAr({ ar_id: 'OTHER-1', customer_phone: ['099999999'] });

interface ScannerFixtureOptions {
  sourceRows?: RawPaymentAr[];
  sourceError?: Error;
  autoApprove?: boolean;
  templateApproved?: boolean;
}

function scannerDeps(options: ScannerFixtureOptions) {
  const proposals = new InMemoryPaymentProposalStore();
  const health = { last_error_code: null as string | null, summaries: [] as PaymentScanResult[] };
  return {
    source: {
      findCandidates: async () => {
        if (options.sourceError) throw options.sourceError;
        return options.sourceRows ?? [];
      },
    },
    proposals,
    health,
    template: approvedTemplateFixture(options.templateApproved === true),
    workerState: { auto_approve: options.autoApprove === true },
  };
}
```

The production `PaymentScannerDependencies` interface must use the same method names, allowing these structural fakes without `as any`.

- [ ] **Step 2: Run and verify RED**

Run: `npm test`

Expected: scanner and health repositories are missing.

- [ ] **Step 3: Implement atomic scan staging**

`run()` first loads the approved template and all source rows. It validates and groups the complete read result before calling any proposal write. Source query failure or an incomplete cursor aborts before writes. Invalid individual ARs and mixed-currency groups are counted and excluded; valid unrelated groups proceed.

For each group, render the approved template and call `upsertPaymentDraft`. Read `auto_approve` only from the `payment_tracker` worker-state document. Record a redacted scan summary in `payment_tracker_scan_state` with timestamps and counts, never customer data.

- [ ] **Step 4: Implement the dedicated cron**

Validate `PAYMENT_TRACKER_SCAN_TIME` with `isValidTimeStr`, default to `10:00`, and schedule with:

```typescript
cron.schedule(dailyCronAt(scanTime), () => {
  scanner.run(new Date()).catch((error) => Logger.error('payment tracker scan failed', error as Error));
}, { timezone: 'Asia/Phnom_Penh' });
```

If `PAYMENT_TRACKER_SCAN_ENABLED !== 'true'`, log that scanning is disabled and create no scheduled task.

- [ ] **Step 5: Verify GREEN**

Run: `npm test`

Run: `npm run typecheck`

- [ ] **Step 6: Commit scanner behavior**

```bash
git add src/payment-tracker/payment-scan-state-repository.ts src/payment-tracker/payment-scanner.ts src/scheduler/payment-tracker-scheduler.ts tests/payment-tracker/payment-scanner.test.ts tests/all.test.ts
git commit -m "feat(payment): scan and draft due receivables"
```

---

### Task 7: Claim-time live verification and source-change transitions

**Files:**
- Create: `src/payment-tracker/payment-claim-service.ts`
- Modify: `src/outreach/outreach-repository.ts`
- Create: `tests/payment-tracker/payment-claim.test.ts`
- Modify: `tests/all.test.ts`

**Interfaces:**
- Produces: `PaymentClaimService.claim(now): Promise<{ proposal: OutreachProposalDocument | null; reason?: string }>`.
- Adds repository methods: `acquirePaymentVerificationLease(orgId, now, leaseMs)`, `releasePaymentVerificationLease(id, orgId, leaseToken, outcome)`, `finalizeVerifiedPaymentClaim(id, orgId, leaseToken, fingerprint, claimLeaseUntil)`, `refreshPaymentProposal(id, orgId, leaseToken, refreshed, mode)`, and `cancelPayment(id, orgId, reason, actor)`.
- Defines test factory: `paymentClaimFixture(options)` over the shared in-memory proposal store and an array-backed `PaymentArSource`.

- [ ] **Step 1: Write failing live-verification tests**

Use in-memory source and proposal fakes to cover:

```typescript
test('cannot claim before Cambodia due-date midnight', async () => {
  const service = paymentClaimFixture({ now: new Date('2026-09-03T16:59:59.999Z') });
  assert.equal((await service.claim()).proposal, null);
});

test('unchanged fully verified proposal becomes in_flight', async () => {
  const service = paymentClaimFixture({ now: new Date('2026-09-03T17:00:00.000Z') });
  const result = await service.claim();
  assert.equal(result.proposal?.status, 'in_flight');
  assert.equal(result.proposal?.verification_state, 'verified');
});

test('all referenced ARs becoming paid cancels before send', async () => {
  const service = paymentClaimFixture({ liveRows: [rawAr({ ar_id: 'AR-1', current_status: 'PAID' }), rawAr({ ar_id: 'AR-2', current_status: 'PAID' })] });
  const result = await service.claim();
  assert.equal(result.proposal, null);
  assert.equal(service.proposal.status, 'cancelled');
  assert.equal(service.proposal.cancelled_reason, 'all_referenced_ars_ineligible');
});

test('manual source change clears approval and returns refreshed proposal to pending', async () => {
  const service = paymentClaimFixture({ autoApprove: false, liveRows: [rawAr({ ar_id: 'AR-1', amount: { value: 130, currency: 'USD' } })] });
  await service.claim();
  assert.equal(service.proposal.status, 'pending');
  assert.equal(service.proposal.approved_at, null);
  assert.equal(service.proposal.payment_balance_due, 110);
});

test('auto source change stays approved but is not returned until another verification', async () => {
  const service = paymentClaimFixture({ autoApprove: true, liveRows: [rawAr({ ar_id: 'AR-1', amount: { value: 130, currency: 'USD' } })] });
  assert.equal((await service.claim()).proposal, null);
  assert.equal(service.proposal.status, 'approved');
  assert.equal(service.proposal.approved_by, 'payment-auto');
});

test('phone or due-date change supersedes old boundary and preserves both audit records', async () => {
  const service = paymentClaimFixture({ liveRows: [rawAr({ ar_id: 'AR-1', customer_phone: ['099999999'] })] });
  await service.claim();
  assert.equal(service.oldProposal.status, 'cancelled');
  assert.equal(service.oldProposal.cancelled_reason, 'source_boundary_changed');
  assert.equal(service.proposals.length, 2);
});

test('outage, unknown status, malformed money, and mixed currencies return no claim', async () => {
  for (const fixture of [sourceOutageFixture(), unknownStatusFixture(), malformedMoneyFixture(), mixedCurrencyFixture()]) {
    const result = await fixture.claim();
    assert.equal(result.proposal, null);
    assert.equal(fixture.proposal.verification_state, 'blocked');
  }
});

test('concurrent claims return a proposal to only one caller', async () => {
  const service = paymentClaimFixture();
  const results = await Promise.all([service.claim(), service.claim()]);
  assert.equal(results.filter((result) => result.proposal).length, 1);
});
```

Define the fixture contract in `payment-claim.test.ts` so each named failure case changes one source behavior:

```typescript
interface ClaimFixtureOptions {
  now?: Date;
  autoApprove?: boolean;
  liveRows?: RawPaymentAr[];
  sourceError?: Error;
}

function paymentClaimFixture(options: ClaimFixtureOptions = {}) {
  const proposalStore = seededApprovedPaymentProposalStore(paymentGroupFixture());
  const sourceRows = options.liveRows ?? paymentGroupFixture().ars.map(validatedArToRawFixture);
  const service = new PaymentClaimService({
    proposals: proposalStore,
    source: arrayBackedPaymentSource(sourceRows, options.sourceError),
    workerState: { getAutoApprove: async () => options.autoApprove === true },
    clock: () => options.now ?? NOW,
    verificationLeaseMs: 60_000,
    claimLeaseMs: 300_000,
  });
  return Object.assign(service, {
    proposal: proposalStore.documents[0],
    oldProposal: proposalStore.documents[0],
    proposals: proposalStore.documents,
  });
}

const sourceOutageFixture = () => paymentClaimFixture({ sourceError: new Error('source unavailable') });
const unknownStatusFixture = () => paymentClaimFixture({ liveRows: [rawAr({ current_status: 'UNKNOWN' })] });
const malformedMoneyFixture = () => paymentClaimFixture({ liveRows: [rawAr({ amount: null })] });
const mixedCurrencyFixture = () => paymentClaimFixture({ liveRows: [rawAr({ ar_id: 'AR-1' }), rawAr({ ar_id: 'AR-2', amount: { value: 100, currency: 'KHR' }, credit_applied: { value: 0, currency: 'KHR' } })] });
```

Implement `validatedArToRawFixture`, `seededApprovedPaymentProposalStore`, and `arrayBackedPaymentSource` in `tests/helpers/payment-fixtures.ts` with exact field reversal and exact-date filtering; these helpers must not relax production validation.

- [ ] **Step 2: Run and verify RED**

Run: `npm test`

Expected: claim service and verification-lease methods are missing.

- [ ] **Step 3: Implement verification leasing and full source reread**

Acquire with one `findOneAndUpdate` restricted to exact `org_id: 'payment_tracker'`, `type: 'payment'`, `status: 'approved'`, `send_not_before: { $lte: now }`, retry time due, and absent/expired verification lease. Store a random lease token and expiry.

Read all referenced IDs without a status filter and the complete due-date candidate set. Validate the referenced results before deriving membership. Treat missing IDs explicitly; do not confuse a filtered status result with a missing record.

- [ ] **Step 4: Implement cancellation, rebuild, and compare-and-set claim**

Use the exact transitions asserted above. A source error sets `verification_state: 'blocked'`, a machine-readable error code, and `verification_retry_after = now + 10 minutes`, then clears the verification lease. A changed proposal never returns to the worker in the same request.

Finalize only when `_id`, exact org, `status: 'approved'`, lease token, and stored fingerprint still match. Set `status: 'in_flight'`, `lease_expires_at`, `verification_state: 'verified'`, and `verified_at` in that single compare-and-set.

- [ ] **Step 5: Verify GREEN**

Run: `npm test`

Run: `npm run typecheck`

- [ ] **Step 6: Commit claim protection**

```bash
git add src/payment-tracker/payment-claim-service.ts src/outreach/outreach-repository.ts tests/payment-tracker/payment-claim.test.ts tests/all.test.ts
git commit -m "feat(payment): verify receivables at claim time"
```

---

### Task 8: Strict worker API isolation and Payment delivery reservations

**Files:**
- Modify: `src/api/outreach-routes.ts:68-81,119-140,266-395,729-745,945-1235`
- Modify: `src/api/server.ts:20-35`
- Modify: `src/outreach/outreach-worker-state-repository.ts`
- Create: `src/outreach/worker-org-middleware.ts`
- Create: `src/outreach/worker-proposal-service.ts`
- Create: `tests/helpers/http.ts`
- Create: `tests/payment-tracker/worker-isolation.test.ts`
- Modify: `tests/all.test.ts`

**Interfaces:**
- Produces middleware: `requireWorkerOrg(req, res, next)` which stores `res.locals.workerOrg`.
- Adds worker-state methods: `tryReservePaymentDelivery(orgId, cap, now)`, `completePaymentDelivery(orgId, now)`, and `releasePaymentDelivery(orgId, now)`.
- Consumes: `PaymentClaimService` for Payment claims and the existing `claimNextApproved` for sales claims.
- Produces: `WorkerProposalService.getMedia(id, orgId)`, `.markSent(id, orgId)`, and `.markFailed(id, orgId, reason)` with injectable repositories.

- [ ] **Step 1: Write failing middleware, cap, and foreign-proposal tests**

```typescript
test('agent request without one valid X-Org-Id is rejected instead of using Company', () => {
  assert.equal(runWorkerOrgMiddleware(undefined).status, 400);
  assert.equal(runWorkerOrgMiddleware('invalid').status, 400);
  assert.equal(runWorkerOrgMiddleware(['company']).status, 400);
  assert.equal(runWorkerOrgMiddleware('payment_tracker').locals.workerOrg, 'payment_tracker');
});

test('Payment worker cannot read media or mutate Company and Personal proposals', async () => {
  const fixture = makeOutreachTestApp(seedCompanyPersonalAndPaymentProposals());
  for (const id of [COMPANY_ID, PERSONAL_ID]) {
    assert.equal((await request(fixture.app, 'GET', `/${id}/effective-media`, 'payment_tracker')).status, 404);
    assert.equal((await request(fixture.app, 'GET', `/${id}/effective-image`, 'payment_tracker')).status, 404);
    assert.equal((await request(fixture.app, 'POST', `/${id}/mark-sent`, 'payment_tracker')).status, 404);
    assert.equal((await request(fixture.app, 'POST', `/${id}/mark-failed`, 'payment_tracker', { reason: 'test' })).status, 404);
  }
  assert.deepEqual(fixture.snapshot(COMPANY_ID), fixture.original(COMPANY_ID));
  assert.deepEqual(fixture.snapshot(PERSONAL_ID), fixture.original(PERSONAL_ID));
});

test('Payment claim never returns an approved Company or Personal proposal', async () => {
  const fixture = makeOutreachTestApp(seedCompanyPersonalAndPaymentProposals({ paymentStatus: 'cancelled' }));
  const result = await request(fixture.app, 'POST', '/claim', 'payment_tracker');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { proposal: null });
  assert.equal(fixture.snapshot(COMPANY_ID)?.status, 'approved');
  assert.equal(fixture.snapshot(PERSONAL_ID)?.status, 'approved');
});

test('two concurrent Payment reservations cannot exceed successful-delivery cap', async () => {
  const state = makeWorkerState({ deliveries_today: 14, delivery_reservations: 0 });
  const granted = await Promise.all([
    state.tryReservePaymentDelivery('payment_tracker', 15, NOW),
    state.tryReservePaymentDelivery('payment_tracker', 15, NOW),
  ]);
  assert.equal(granted.filter(Boolean).length, 1);
});

test('Payment mark failed releases reservation without writing sales phone suppression', async () => {
  const fixture = paymentFailureRouteFixture();
  await fixture.markFailed(PAYMENT_ID, 'payment_tracker', 'privacy');
  assert.equal(fixture.workerState.delivery_reservations, 0);
  assert.equal(fixture.salesSuppressions.length, 0);
  assert.deepEqual(fixture.alerts, [{ proposalId: PAYMENT_ID, kind: 'mark-failed', reason: 'privacy' }]);
});

test('Payment worker state starts paused while sales worker defaults stay unchanged', () => {
  assert.equal(defaultWorkerState('payment_tracker').paused, true);
  assert.equal(defaultWorkerState('company').paused, false);
  assert.equal(defaultWorkerState('personal').paused, false);
});
```

Define `tests/helpers/http.ts` as a real loopback helper using `node:http` and an ephemeral port:

```typescript
import http from 'node:http';
import type { Express } from 'express';

export async function request(
  app: Express,
  method: string,
  path: string,
  org?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        Authorization: 'Bearer test-agent-token',
        ...(org ? { 'X-Org-Id': org } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
```

`worker-isolation.test.ts` builds its Express app with `authMiddleware`, `requireWorkerOrg`, and a test-only router whose handlers call the real `WorkerProposalService`. Define these local fixtures:

```typescript
const COMPANY_ID = '64b000000000000000000001';
const PERSONAL_ID = '64b000000000000000000002';
const PAYMENT_ID = '64b000000000000000000003';

function runWorkerOrgMiddleware(header: unknown) {
  const req = { headers: { 'x-org-id': header } } as Request;
  const locals: Record<string, unknown> = {};
  let status = 200;
  const res = {
    locals,
    status(code: number) { status = code; return this; },
    json() { return this; },
  } as unknown as Response;
  requireWorkerOrg(req, res, () => undefined);
  return { status, locals };
}

function seedCompanyPersonalAndPaymentProposals(options: { paymentStatus?: OutreachStatus } = {}): InMemoryPaymentProposalStore {
  return new InMemoryPaymentProposalStore([
    proposalFixture(COMPANY_ID, 'company', 'approved'),
    proposalFixture(PERSONAL_ID, 'personal', 'approved'),
    paymentProposalFixture(PAYMENT_ID, options.paymentStatus ?? 'in_flight'),
  ]);
}

const makeWorkerState = (initial: { deliveries_today: number; delivery_reservations: number }) =>
  new InMemoryWorkerStateRepository(initial, () => NOW);

const makeOutreachTestApp = (store: InMemoryPaymentProposalStore) => {
  const originals = structuredClone(store.documents);
  return {
    app: createWorkerTestApp(new WorkerProposalService({ proposals: store, media: new InMemoryMediaStore(), workerState: makeWorkerState({ deliveries_today: 0, delivery_reservations: 0 }), audit: new InMemoryAuditSink() })),
    snapshot: (id: string) => structuredClone(store.documents.find((document) => String(document._id) === id)),
    original: (id: string) => structuredClone(originals.find((document) => String(document._id) === id)),
  };
};

const paymentFailureRouteFixture = () => {
  const proposals = seededInFlightPaymentProposalStore(paymentGroupFixture());
  const salesSuppressions: unknown[] = [];
  const alerts: Array<{ proposalId: string; kind: string; reason: string }> = [];
  const workerState = makeWorkerState({ deliveries_today: 0, delivery_reservations: 1 });
  return {
    workerState,
    salesSuppressions,
    alerts,
    markFailed: (id: string, org: OrgId, reason: string) => new WorkerProposalService({ proposals, workerState, salesSuppressions, alerts }).markFailed(id, org, reason),
  };
};
```

Create the named in-memory media/audit/state helpers in `worker-isolation.test.ts`; each stores calls in arrays and implements the exact `WorkerProposalServiceDependencies` port without `as any`.

- [ ] **Step 2: Run and verify RED**

Run: `npm test`

Expected: middleware, test router factory, and reservation fields/methods are missing.

- [ ] **Step 3: Implement strict agent organization middleware**

After `agentOnly`, run `requireWorkerOrg` on claim, heartbeat, alert, inbound, worker-readable settings/media, mark-sent, and mark-failed routes. For endpoints shared with browsers, use `res.locals.workerOrg` when the role is agent and `resolveOrg(req)` otherwise.

Add `X-Org-Id` to `Access-Control-Allow-Headers`. Never call `normalizeOrg` on a worker-supplied value.

- [ ] **Step 4: Add atomic Payment reservation accounting**

Add `delivery_reservations: number` to worker state, defaulting to zero. Set `paused: true` only when creating the initial `payment_tracker` state; Company and Personal continue to default to false. Payment reservation uses the Cambodia date key and a `findOneAndUpdate` query with `$expr` requiring `deliveries_today + delivery_reservations < cap`, then increments `delivery_reservations`. Payment success increments `deliveries_today` and decrements a positive reservation in one update. Payment failure/no-claim/expired lease decrements a positive reservation.

Keep existing Company/Personal `tryReserveClaim`, `recordDelivery`, and `releaseClaim` behavior unchanged.

- [ ] **Step 5: Route claims and terminal operations by proposal type**

Use `PAYMENT_TRACKER_DAILY_CAP` with fallback 15 only for Payment. A Payment claim reserves a delivery, calls `PaymentClaimService`, and releases when no proposal is returned. Company/Personal keep `dailyCap()` and `claimNextApproved`.

Payment mark-sent records delivery but does not create `LeadEventDocument` and does not call the sales suppression repository. Payment mark-failed releases the Payment reservation and relies on its terminal proposal dedupe key. Keep the existing audit log and failure alert, using the already org-scoped proposal.

- [ ] **Step 6: Verify GREEN and run isolation-focused tests twice**

Run: `npm test`

Run: `npm test`

Run: `npm run typecheck`

Expected: both repeated runs pass, showing no order-dependent shared state.

- [ ] **Step 7: Commit worker API isolation**

```bash
git add src/api/outreach-routes.ts src/api/server.ts src/outreach/outreach-worker-state-repository.ts src/outreach/worker-org-middleware.ts src/outreach/worker-proposal-service.ts tests/helpers/http.ts tests/payment-tracker/worker-isolation.test.ts tests/all.test.ts
git commit -m "fix(outreach): enforce strict worker organization scope"
```

---

### Task 9: Payment settings API and outreach UI

**Files:**
- Create: `src/api/payment-tracker-routes.ts`
- Create: `src/payment-tracker/payment-settings-service.ts`
- Modify: `src/api/outreach-routes.ts`
- Modify: `src/api/crm-routes.ts:26-29,116-124`
- Modify: `src/reports/templates/partials/nav.hbs:85-95`
- Modify: `src/reports/templates/crm/outreach.hbs`
- Create: `tests/payment-tracker/payment-ui.test.ts`
- Modify: `tests/all.test.ts`

**Interfaces:**
- Produces dashboard endpoints: `GET/PUT /crm/api/outreach/payment/template`, `POST .../template/approve`, `GET .../source-status`, and `POST .../scan-now`.
- Reuses existing proposal list, approve, edit, cancel, pause, and Auto endpoints with Payment-aware guards.
- Produces: `PaymentSettingsService.saveTemplate`, `.approveTemplate`, `.setAutoApprove`, and `.getSourceStatus` for route-level dependency injection.

- [ ] **Step 1: Use the frontend-design skill before changing the template**

Read `frontend-design:frontend-design` and retain the dashboard's current visual language. This task adds information hierarchy and conditional panels; it does not redesign unrelated pages.

- [ ] **Step 2: Write failing rendered-HTML and API tests**

```typescript
test('Payment workspace renders payment controls and hides sales generation controls', async () => {
  const html = await renderOutreachForOrg('payment_tracker');
  assert.match(html, /Payment reminder wording/);
  assert.match(html, /Approve wording/);
  assert.match(html, /Source verification/);
  assert.doesNotMatch(html, /Generate drafts for stale leads/);
  assert.doesNotMatch(html, /Retry deferred/);
});

test('Company workspace keeps existing sales controls', async () => {
  const html = await renderOutreachForOrg('company');
  assert.match(html, /Generate/);
  assert.match(html, /Retry deferred/);
  assert.doesNotMatch(html, /Payment reminder wording/);
});

test('editing wording revokes UI approval and Auto cannot enable until reapproved', async () => {
  const fixture = paymentSettingsApiFixture();
  await fixture.putTemplate('Pay {{amount_due}} {{currency}}', 'developer');
  assert.equal((await fixture.enableAuto()).status, 409);
  await fixture.approveTemplate('developer');
  assert.equal((await fixture.enableAuto()).status, 200);
});

test('enabling Payment Auto approves all existing Payment Pending drafts only', async () => {
  const fixture = paymentSettingsApiFixture([
    paymentProposalFixture('64b000000000000000000003', 'pending'),
    paymentProposalFixture('64b000000000000000000004', 'pending'),
    proposalFixture('64b000000000000000000001', 'company', 'pending'),
  ]);
  await fixture.putTemplate('Pay {{amount_due}} {{currency}}', 'developer');
  await fixture.approveTemplate('developer');
  assert.equal((await fixture.enableAuto()).status, 200);
  assert.deepEqual(fixture.proposals.documents.filter((p) => p.org_id === 'payment_tracker').map((p) => p.status), ['approved', 'approved']);
  assert.equal(fixture.proposals.documents.find((p) => p.org_id === 'company')?.status, 'pending');
});
```

Define the two test helpers locally:

```typescript
async function renderOutreachForOrg(org: OrgId): Promise<string> {
  return renderPage('crm/outreach', {
    activeOrg: org,
    orgs: OUTREACH_ORGS,
    isPaymentTracker: org === PAYMENT_TRACKER_ORG,
  });
}

function paymentSettingsApiFixture(seed: OutreachProposalDocument[] = []) {
  let templateDocument: PaymentTemplateDocument | null = null;
  const templates = new PaymentTemplateRepository({
    findOne: async () => templateDocument,
    replaceOne: async (_filter, document) => { templateDocument = structuredClone(document); },
  }, () => NOW);
  let autoApprove = false;
  const workerState = {
    getAutoApprove: async () => autoApprove,
    setAutoApprove: async (enabled: boolean) => { autoApprove = enabled; },
  };
  const proposals = new InMemoryPaymentProposalStore(seed);
  const service = new PaymentSettingsService({ templates, workerState, proposals });
  return {
    proposals,
    putTemplate: (text: string, actor: string) => service.saveTemplate(text, actor),
    approveTemplate: (actor: string) => service.approveTemplate(actor),
    enableAuto: async () => {
      try {
        await service.setAutoApprove(true, 'developer');
        return { status: 200 };
      } catch (error) {
        return { status: error instanceof PaymentActivationError ? 409 : 500 };
      }
    },
  };
}
```

Export `PaymentActivationError` from `payment-settings-service.ts`; routes map it to HTTP 409 and do not mutate Auto state on failure.

- [ ] **Step 3: Run and verify RED**

Run: `npm test`

Expected: Payment API routes and conditional HTML are absent.

- [ ] **Step 4: Implement Payment settings and activation endpoints**

Mount the Payment router under `/payment`. Restrict mutation endpoints to dashboard users. `scan-now` calls the registered Payment scheduler and still refuses if the source credential or approved wording is unavailable. `source-status` returns only redacted scan/inspection metadata.

Update `/auto-approve`: when org is Payment and target is true, require an active approved Payment template before changing state or bulk-approving Pending drafts. Bulk approval remains scoped to `payment_tracker`.

- [ ] **Step 5: Implement conditional UI and payment proposal cards**

Pass `isPaymentTracker: activeOrg === 'payment_tracker'` from `crm-routes.ts`. Add the Cancelled tab. In Payment mode show exact AR/home references, amount/credit/balance, currency, local due date, billing month, send-not-before, fingerprint, verification state/time/error, and cancellation reason. Hide sales-only manual generation, shared sales schedule editor, sales reasoning, stale-days badges, and deferred retry.

Use text nodes or the existing `esc()` function for every source-backed field. Do not inject source values into raw HTML or URLs except the already encoded Telegram phone link.

- [ ] **Step 6: Verify GREEN and render both workspaces**

Run: `npm test`

Run: `npm run typecheck`

Expected: Payment and Company render tests pass and Company retains existing controls.

- [ ] **Step 7: Commit UI and API**

```bash
git add src/api/payment-tracker-routes.ts src/payment-tracker/payment-settings-service.ts src/api/outreach-routes.ts src/api/crm-routes.ts src/reports/templates/partials/nav.hbs src/reports/templates/crm/outreach.hbs tests/payment-tracker/payment-ui.test.ts tests/all.test.ts
git commit -m "feat(payment): add tracker workflow to outreach UI"
```

---

### Task 10: Guarded session provisioning and separate PM2 worker

**Files:**
- Create: `scripts/telegram-worker/worker-config.ts`
- Create: `scripts/telegram-worker/payment-session-guard.ts`
- Create: `scripts/telegram-worker/login-payment-tracker.ts`
- Create: `scripts/telegram-worker/ecosystem.payment-tracker.config.js`
- Create: `tests/payment-tracker/payment-worker-config.test.ts`
- Modify: `scripts/telegram-worker/worker.ts:32-40`
- Modify: `scripts/telegram-worker/package.json`
- Modify: `scripts/telegram-worker/.gitignore`
- Modify: `tests/all.test.ts`

**Interfaces:**
- Produces: `requireWorkerOrgId(value)` and `resolvePaymentSessionTarget(cwd, configuredPath)`.
- Adds command: `npm run login:payment` within `scripts/telegram-worker`.
- Adds PM2 app: `outreach-worker-payment-tracker` only in the separate ecosystem file.

- [ ] **Step 1: Write failing worker/session guard tests**

```typescript
test('worker refuses missing and invalid ORG_ID before network activity', () => {
  assert.throws(() => requireWorkerOrgId(undefined), /ORG_ID must be explicitly set/);
  assert.throws(() => requireWorkerOrgId('unknown'), /invalid ORG_ID/);
  assert.equal(requireWorkerOrgId('company'), 'company');
  assert.equal(requireWorkerOrgId('personal'), 'personal');
  assert.equal(requireWorkerOrgId('payment_tracker'), 'payment_tracker');
});

test('payment login permits only the exact non-existing payment session file', () => {
  const cwd = path.resolve('scripts/telegram-worker');
  assert.equal(
    resolvePaymentSessionTarget(cwd, './telegram-string-session-payment-tracker.txt'),
    path.join(cwd, 'telegram-string-session-payment-tracker.txt'),
  );
  for (const target of ['./telegram-string-session.txt', './telegram-string-session-personal.txt', '../payment.txt']) {
    assert.throws(() => resolvePaymentSessionTarget(cwd, target));
  }
});

test('payment PM2 configuration contains only the isolated Payment app', () => {
  const config = require('../../scripts/telegram-worker/ecosystem.payment-tracker.config.js');
  assert.deepEqual(config.apps.map((app: { name: string }) => app.name), ['outreach-worker-payment-tracker']);
  assert.equal(config.apps[0].env.ORG_ID, 'payment_tracker');
  assert.equal(config.apps[0].env.STRING_SESSION_PATH, './telegram-string-session-payment-tracker.txt');
  assert.equal(config.apps[0].env.DAILY_CAP, '15');
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test`

Expected: config/guard modules and Payment ecosystem file are missing.

- [ ] **Step 3: Extract strict worker config without changing MTProto behavior**

Replace only `const ORG_ID = process.env.ORG_ID || 'company'` with `requireWorkerOrgId(process.env.ORG_ID)`. Keep contact import, peer lookup, media staging/sending, inbound handlers, delays, heartbeat cadence, and send loop unchanged. Reconcile this edit with the existing uncommitted `fetchEffectiveMedia`/media-kind changes; do not revert them.

- [ ] **Step 4: Implement guarded Payment login**

The command forces the exact filename, checks the resolved parent directory is the real worker directory, rejects symlinked/foreign targets, calls `fs.openSync(path, 'wx', 0o600)` only after Telegram returns the StringSession, writes through that exclusive descriptor, and deletes an empty file if writing fails. It never reads `STRING_SESSION_PATH` as an override.

Add:

```json
"login:payment": "ts-node login-payment-tracker.ts"
```

Add `telegram-string-session-payment-tracker.txt` to the worker `.gitignore`.

- [ ] **Step 5: Implement the separate PM2 definition**

Copy only the existing shared runtime settings needed by one app and define:

```javascript
{
  name: 'outreach-worker-payment-tracker',
  env: {
    ORG_ID: 'payment_tracker',
    STRING_SESSION_PATH: './telegram-string-session-payment-tracker.txt',
    WORKER_ID: 'outreach-payment-tracker',
    DAILY_CAP: '15',
  },
}
```

Do not add this app to `ecosystem.config.js`.

- [ ] **Step 6: Verify GREEN and compile the worker**

Run: `npm test`

Run from `scripts/telegram-worker`: `npm run build`

Expected: tests pass; existing Company/Personal PM2 file remains a two-app file with unchanged names and session paths.

- [ ] **Step 7: Commit worker provisioning**

```bash
git add scripts/telegram-worker/worker-config.ts scripts/telegram-worker/payment-session-guard.ts scripts/telegram-worker/login-payment-tracker.ts scripts/telegram-worker/ecosystem.payment-tracker.config.js scripts/telegram-worker/worker.ts scripts/telegram-worker/package.json scripts/telegram-worker/.gitignore tests/payment-tracker/payment-worker-config.test.ts tests/all.test.ts
git commit -m "feat(payment): provision isolated Telegram worker"
```

---

### Task 11: Startup wiring, inspection command, documentation, and full regressions

**Files:**
- Modify: `src/index.ts`
- Create: `src/payment-tracker/payment-config.ts`
- Create: `scripts/check-payment-tracker-source.ts`
- Create: `.env.example`
- Modify: `scripts/telegram-worker/README.md`
- Modify: `OUTREACH_RUNBOOK.md`
- Create: `tests/payment-tracker/startup-config.test.ts`
- Modify: `tests/all.test.ts`

**Interfaces:**
- Registers: `PaymentTrackerScheduler` with scanning disabled unless explicitly enabled.
- Adds operator command: `npx ts-node scripts/check-payment-tracker-source.ts`.
- Produces: `readPaymentTrackerConfig(env)` returning `{ scanEnabled, scanTime, dailyCap }`.

- [ ] **Step 1: Write failing safe-default startup tests**

```typescript
test('Payment configuration defaults are disabled, 10:00, and cap 15', () => {
  assert.deepEqual(readPaymentTrackerConfig({}), {
    scanEnabled: false,
    scanTime: '10:00',
    dailyCap: 15,
  });
});

test('invalid scan time and cap fail configuration validation', () => {
  assert.throws(() => readPaymentTrackerConfig({ PAYMENT_TRACKER_SCAN_TIME: '25:00' }));
  assert.throws(() => readPaymentTrackerConfig({ PAYMENT_TRACKER_DAILY_CAP: '0' }));
});
```

Implement the configuration parser exactly as follows:

```typescript
export interface PaymentTrackerConfig {
  scanEnabled: boolean;
  scanTime: string;
  dailyCap: number;
}

export function readPaymentTrackerConfig(env: NodeJS.ProcessEnv): PaymentTrackerConfig {
  const scanTime = env.PAYMENT_TRACKER_SCAN_TIME || '10:00';
  if (!isValidTimeStr(scanTime)) throw new Error('PAYMENT_TRACKER_SCAN_TIME must be HH:MM');
  const rawCap = env.PAYMENT_TRACKER_DAILY_CAP || '15';
  const dailyCap = Number(rawCap);
  if (!Number.isInteger(dailyCap) || dailyCap <= 0) throw new Error('PAYMENT_TRACKER_DAILY_CAP must be a positive integer');
  return { scanEnabled: env.PAYMENT_TRACKER_SCAN_ENABLED === 'true', scanTime, dailyCap };
}
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test`

Expected: centralized Payment configuration and startup registration are absent.

- [ ] **Step 3: Wire startup and graceful disconnect**

Create the scanner/scheduler after the main database connects. `startScheduler()` must be harmless while disabled and must not connect to Payment Mongo during disabled startup. On SIGINT/SIGTERM, disconnect the Payment source client only if it was connected, then disconnect the main database.

Create `.env.example` with exactly these safe Payment defaults and a blank credential:

```dotenv
PAYMENT_TRACKER_DATABASE_URL=
PAYMENT_TRACKER_SCAN_ENABLED=false
PAYMENT_TRACKER_SCAN_TIME=10:00
PAYMENT_TRACKER_DAILY_CAP=15
```

- [ ] **Step 4: Add the redacted source inspection command**

The command calls `inspectPaymentSource()`, prints no customer fields or URI, exits 1 for excess privileges, wrong namespace, wrong BSON date type, absent `ar_id` uniqueness, or a winning plan that does not use `current_status_1_due_date_1`/an equivalent prefix. Missing phones or credits print a data-readiness blocker and exit 2 without changing source data.

- [ ] **Step 5: Document the staged operational sequence**

Update both runbooks with these commands and stop points:

```powershell
npx ts-node scripts/check-payment-tracker-source.ts
cd scripts/telegram-worker
npm run login:payment
pm2 start ecosystem.payment-tracker.config.js
pm2 stop outreach-worker-payment-tracker
```

Document that the PM2 app is started paused only after server-side Payment pause is confirmed; Manual scanning is enabled before Auto; Company/Personal ecosystem commands remain unchanged; the current `atlasAdmin` URI is forbidden.

- [ ] **Step 6: Run the focused and compile verification suite**

Run: `npm test`

Run: `npx tsc -p tsconfig.test.json`

Run: `npm run typecheck`

Run: `npm run build`

Run from `scripts/telegram-worker`: `npm run build`

Expected: every command exits 0 with no TypeScript errors.

- [ ] **Step 7: Run Company/Personal regression checks**

Run the non-network pure checks first:

```powershell
node scripts/check-bounce-precedes-scan.js
node scripts/check-outreach-schedule-setting.js
node scripts/check-auto-approve-toggle.js
```

With an isolated audit-sales test database and test API process, run:

```powershell
node scripts/check-scan-topup.js
node scripts/check-failure-routing.js
node scripts/check-marksent-cooldown.js
npx ts-node scripts/check-outreach-extra-media.ts
node scripts/check-outreach-worker.js
```

Add assertions to the new `worker-isolation.test.ts` suite for heartbeat and inbound requests with missing/invalid org headers, then rerun `npm test`. Do not point mutation-capable check scripts at production.

- [ ] **Step 8: Run the source rollout check only with the new credential**

Run: `npx ts-node scripts/check-payment-tracker-source.ts`

Expected before rollout: effective privileges are limited to `find` and `listIndexes` on `ar_tracker.ar_state`; `due_date` is BSON Date; `ar_id_1` is unique; candidate explain uses the compound status/date index. If phones or credit remain null/missing, report data readiness exit 2 and leave scanning disabled.

- [ ] **Step 9: Review the final diff for isolation and forbidden source writes**

Run:

```powershell
git diff --check
rg -n "ar_state" src scripts
rg -n "createIndex|insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|replaceOne|bulkWrite" src/payment-tracker scripts/check-payment-tracker-source.ts
git diff -- scripts/telegram-worker/ecosystem.config.js
git status --short
```

Expected: `ar_state` references are confined to projected reads/inspection; no source write/index method exists; the Company/Personal ecosystem diff is empty; unrelated pre-existing changes remain unstaged.

- [ ] **Step 10: Commit wiring and operational documentation**

```bash
git add src/index.ts src/payment-tracker/payment-config.ts scripts/check-payment-tracker-source.ts .env.example scripts/telegram-worker/README.md OUTREACH_RUNBOOK.md tests/payment-tracker/startup-config.test.ts tests/payment-tracker/worker-isolation.test.ts tests/all.test.ts
git commit -m "docs(payment): wire guarded rollout and verification"
```

---

## Final acceptance gate

Do not claim the feature ready for rollout unless all Task 11 commands pass and the new source credential passes collection-scoped privilege inspection. If source phones or credits remain null/missing, the implementation may be code-complete with scanning disabled, but operational reminder delivery remains blocked and must be reported as such.
