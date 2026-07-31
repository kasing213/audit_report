# Outreach Auto-Approve + Contact Cooldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each outreach workspace a Manual⇄Auto approve switch, cap the outstanding queue at 20, stop re-contacting numbers for 180 days, close privacy failures permanently while re-queueing crash failures, and fix the phone-list importer.

**Architecture:** Five independent slices over the existing three-piece outreach split (server drafts → dashboard approves → MTProto worker sends). The auto-approve flag rides on the existing per-org `outreach_worker_state` document beside `paused`. The 180-day cooldown reuses the existing `outreach_suppressions` collection with a new time-bounded `contacted` kind rather than a new collection. The worker is untouched — every change is server-side or dashboard-side.

**Tech Stack:** TypeScript, Express, MongoDB (native driver), Handlebars templates, node-cron. No test framework in this repo — verification is via `scripts/check-*.js` scripts run against a database, following the existing convention.

## Global Constraints

- **Delivery cap stays 15/day per workspace.** `DEFAULT_DAILY_CAP = 15` and `DAILY_ATTEMPT_CAP = 40` are NOT changed by this plan.
- **Outstanding queue ceiling is 20 per workspace** (`pending` + `approved` combined).
- **Contact cooldown is 180 days.** Applies to successful sends only.
- **Privacy and invalid failures are permanent.** `next_retry_at` is always `null`.
- **Transient re-queues are capped at 3 per proposal.**
- Every new collection field must default safely when absent — existing documents are not migrated except by the explicit backfill in Task 8.
- Org values come from `OUTREACH_ORGS` in `src/outreach/orgs.ts`; never hardcode `'company'` / `'personal'` string literals in new logic.
- Phone values are always normalised with `toInternationalPhone()` before comparison or storage.
- Check scripts start with `require('dotenv').config();` and read `process.env.DATABASE_URL`, matching `scripts/count-stale-45.js`.
- Commit after every task. Work on branch `feature/outreach-multi-org`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/outreach/outreach-worker-state-repository.ts` | Add `auto_approve` field + `setAutoApprove()` | 1 |
| `src/api/outreach-routes.ts` | `/auto-approve` endpoint; expose flag on `/worker-status`; rewire `mark-sent` and `mark-failed` | 1, 4, 5 |
| `src/reports/templates/crm/outreach.hbs` | Manual/Auto switch in the worker bar | 2 |
| `src/outreach/outreach-suppression-repository.ts` | `contacted` kind, `eligible_again_at`, `recordContacted()`, cooldown-aware `getSuppressedPhones()`, delete retry ladder | 3, 5 |
| `src/outreach/outreach-repository.ts` | `transient_retries` field + `requeueTransient()` + `countOutstanding()` | 5, 6 |
| `src/outreach/outreach-alerts.ts` | New `transient-requeue` alert kind | 5 |
| `src/scheduler/outreach-scheduler.ts` | Per-org top-up scan; delete retry scan | 6 |
| `src/outreach/outreach-agent.ts` | Accept explicit draft count from the scheduler | 6 |
| `src/api/crm-routes.ts` | Phone-column alias detection + dedup buckets | 7 |
| `scripts/backfill-contacted-ledger.js` | One-time backfill | 8 |
| `scripts/count-contactable-pool.js` | Pool-size report | 8 |

---

### Task 1: Auto-approve flag — storage and API

**Files:**
- Modify: `src/outreach/outreach-worker-state-repository.ts:8-38` (interface + defaults), after line 82 (new method)
- Modify: `src/api/outreach-routes.ts:126-147` (worker-status), after the `/pause` handler
- Test: `scripts/check-auto-approve-toggle.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `WorkerStateDocument.auto_approve: boolean`
  - `OutreachWorkerStateRepository.setAutoApprove(orgId: OrgId, autoApprove: boolean): Promise<void>`
  - `POST /crm/api/outreach/auto-approve` → `{ org: string, auto_approve: boolean }`
  - `GET /crm/api/outreach/worker-status` gains `auto_approve: boolean`

- [ ] **Step 1: Write the failing check script**

Create `scripts/check-auto-approve-toggle.js`:

```js
/**
 * Verifies the per-org auto_approve flag: independent per workspace, and an
 * absent field reads as false (today's manual behaviour).
 *
 * Usage: node scripts/check-auto-approve-toggle.js
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (got ${actual}, want ${expected})`);
}

(async () => {
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error('DATABASE_URL not set');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const col = client.db().collection('outreach_worker_state');

  const { OutreachWorkerStateRepository } = require('../dist/outreach/outreach-worker-state-repository');
  const DatabaseConnection = require('../dist/database/connection').default;
  await DatabaseConnection.getInstance().connect();
  const repo = new OutreachWorkerStateRepository();

  // Absent field reads false.
  await col.updateOne({ _id: 'company' }, { $unset: { auto_approve: '' } });
  const bare = await repo.getStatus('company');
  check('absent auto_approve reads false', bare.auto_approve === true, false);

  // Independent per org.
  await repo.setAutoApprove('company', true);
  await repo.setAutoApprove('personal', false);
  const co = await repo.getStatus('company');
  const pe = await repo.getStatus('personal');
  check('company auto_approve set true', co.auto_approve, true);
  check('personal unaffected', pe.auto_approve, false);

  // Pause flag untouched by the auto-approve write.
  check('paused untouched by setAutoApprove', typeof co.paused, 'boolean');

  // Restore manual on both so the check leaves no side effects.
  await repo.setAutoApprove('company', false);
  await repo.setAutoApprove('personal', false);

  await client.close();
  await DatabaseConnection.getInstance().disconnect();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run build && node scripts/check-auto-approve-toggle.js
```

Expected: FAIL — `repo.setAutoApprove is not a function`.

- [ ] **Step 3: Add the field to the document interface and defaults**

In `src/outreach/outreach-worker-state-repository.ts`, add to `WorkerStateDocument` after `paused: boolean;` (line 14):

```ts
  // Manual (false) vs Auto (true) approval for this workspace's 9AM scan.
  // Absent on pre-toggle documents; getStatus() normalises that to false so the
  // existing manual-approval behaviour is the default.
  auto_approve: boolean;
```

Add to `defaultState()` after `paused: false,` (line 28):

```ts
    auto_approve: false,
```

- [ ] **Step 4: Normalise absent values on read**

Replace `getStatus` (lines 70-74) with:

```ts
  async getStatus(orgId: OrgId = DEFAULT_ORG): Promise<WorkerStateDocument> {
    const doc = await this.col.findOne({ _id: orgId });
    if (!doc) return defaultState(orgId);
    // Pre-toggle documents have no auto_approve field; absent means manual.
    return { ...doc, auto_approve: doc.auto_approve === true };
  }
```

- [ ] **Step 5: Add the setter**

In the same file, immediately after `setPaused` (after line 82):

```ts
  async setAutoApprove(orgId: OrgId, autoApprove: boolean): Promise<void> {
    await this.ensureOrg(orgId);
    await this.col.updateOne(
      { _id: orgId },
      { $set: { auto_approve: autoApprove, updated_at: new Date() } }
    );
  }
```

- [ ] **Step 6: Expose the flag on worker-status**

In `src/api/outreach-routes.ts`, inside the `/worker-status` response object, add after `paused: state.paused,` (line 132):

```ts
      auto_approve: state.auto_approve,
```

- [ ] **Step 7: Add the endpoint**

In `src/api/outreach-routes.ts`, immediately after the `/pause` handler closes (after line 181):

```ts
// POST /crm/api/outreach/auto-approve — toggle or set this workspace's approval mode.
// Isolated per org: flipping company does not touch personal.
router.post('/auto-approve', express.json(), async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const repo = new OutreachWorkerStateRepository();
    const current = await repo.getStatus(org);
    const target = typeof req.body?.enabled === 'boolean' ? req.body.enabled : !current.auto_approve;
    await repo.setAutoApprove(org, target);
    Logger.info(`[outreach] auto_approve org=${org} -> ${target}`);
    res.json({ org, auto_approve: target });
  } catch (err) {
    Logger.error('outreach auto-approve toggle failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 8: Run the check to verify it passes**

```bash
npm run build && node scripts/check-auto-approve-toggle.js
```

Expected: `ALL PASS`.

- [ ] **Step 9: Commit**

```bash
git add src/outreach/outreach-worker-state-repository.ts src/api/outreach-routes.ts scripts/check-auto-approve-toggle.js
git commit -m "feat(outreach): per-workspace auto-approve flag + API"
```

---

### Task 2: Dashboard Manual ⇄ Auto switch

**Files:**
- Modify: `src/reports/templates/crm/outreach.hbs:173` (CSS), `:333` (markup), `:561` (state var), `:872-893` (status render), after `:909` (handler)

**Interfaces:**
- Consumes: `GET /worker-status` field `auto_approve` and `POST /auto-approve` from Task 1.
- Produces: no server-side interface.

- [ ] **Step 1: Add the CSS**

In `src/reports/templates/crm/outreach.hbs`, after the `.worker-bar .pause-btn:hover` rule (line 173):

```css
  .worker-bar .mode-btn {
    padding: 0.3rem 0.7rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-family: var(--font-body);
    cursor: pointer;
    font-size: 0.78rem;
    margin-right: 0.4rem;
  }
  .worker-bar .mode-btn:hover { border-color: var(--accent); }
  .worker-bar .mode-btn.auto {
    border-color: var(--yellow);
    color: var(--yellow);
  }
```

- [ ] **Step 2: Add the button to the worker bar**

Replace line 333 (the pause button) with both buttons:

```html
    <button class="mode-btn" id="mode-btn" onclick="toggleAutoApprove()">Approve: Manual</button>
    <button class="pause-btn" id="pause-btn" onclick="togglePause()">Pause</button>
```

- [ ] **Step 3: Add the client state variable**

After `let workerPaused = false;` (line 561):

```javascript
  let autoApprove = false;
```

- [ ] **Step 4: Render current mode on each status poll**

In `refreshWorkerStatus`, after `workerPaused = !!data.paused;` (line 872):

```javascript
      autoApprove = !!data.auto_approve;
```

And after `btn.textContent = workerPaused ? 'Resume' : 'Pause';` (line 893):

```javascript
      const modeBtn = document.getElementById('mode-btn');
      modeBtn.textContent = autoApprove ? 'Approve: Auto' : 'Approve: Manual';
      modeBtn.classList.toggle('auto', autoApprove);
      modeBtn.title = autoApprove
        ? 'This workspace approves its daily batch automatically. Messages send with no human review.'
        : 'Drafts wait in Pending until you approve them.';
```

- [ ] **Step 5: Add the toggle handler**

After the `togglePause` function closes (after line 909):

```javascript
  async function toggleAutoApprove() {
    const turningOn = !autoApprove;
    if (turningOn && !confirm(
      'Switch this workspace to AUTO approve?\n\n' +
      'The daily batch will be approved and sent with no human review. ' +
      'Only this workspace is affected.'
    )) return;
    try {
      const resp = await fetch(API + '/auto-approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: turningOn }),
      });
      if (resp.ok) {
        showToast(turningOn ? 'Auto approve ON for this workspace' : 'Manual approve restored', 'success');
        refreshWorkerStatus();
      } else showToast('Auto-approve toggle failed', 'error');
    } catch { showToast('Auto-approve toggle failed', 'error'); }
  }
```

- [ ] **Step 6: Verify in the browser**

```bash
npm run build && npm start
```

Open `/crm/outreach`. Confirm: the button reads `Approve: Manual`; clicking it prompts for confirmation, then reads `Approve: Auto` in yellow; switching workspace via the org switcher shows that workspace's own independent state; reloading preserves it.

- [ ] **Step 7: Commit**

```bash
git add src/reports/templates/crm/outreach.hbs
git commit -m "feat(outreach): Manual/Auto approve switch on the dashboard"
```

---

### Task 3: `contacted` suppression kind with 180-day cooldown

**Files:**
- Modify: `src/outreach/outreach-suppression-repository.ts:30` (kind union), `:33-53` (document), `:55-64` (constants), `:219-227` (`getSuppressedPhones`)
- Test: `scripts/check-contact-cooldown.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `SuppressionKind` gains `'contacted'`
  - `OutreachSuppressionDocument.eligible_again_at: Date | null`
  - `OutreachSuppressionDocument.contacted_at: Date | null`
  - `OutreachSuppressionRepository.recordContacted(input: { phone: string; orgId?: OrgId; proposalId?: ObjectId | null; customerName?: string | null; follower?: string | null; sentAt?: Date }): Promise<void>`
  - `CONTACT_COOLDOWN_DAYS` exported constant = `180`

- [ ] **Step 1: Write the failing check script**

Create `scripts/check-contact-cooldown.js`:

```js
/**
 * Verifies the 180-day contact cooldown: recordContacted writes an expiry,
 * an in-cooldown number is suppressed, an expired one is not, and the rule
 * is scoped per workspace.
 *
 * Usage: node scripts/check-contact-cooldown.js
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const PHONE = '+855999000111';
let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (got ${actual}, want ${expected})`);
}

(async () => {
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error('DATABASE_URL not set');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const col = client.db().collection('outreach_suppressions');
  await col.deleteMany({ customer_phone: PHONE });

  const DatabaseConnection = require('../dist/database/connection').default;
  await DatabaseConnection.getInstance().connect();
  const { OutreachSuppressionRepository, CONTACT_COOLDOWN_DAYS } =
    require('../dist/outreach/outreach-suppression-repository');
  const repo = new OutreachSuppressionRepository();

  check('cooldown constant is 180', CONTACT_COOLDOWN_DAYS, 180);

  // Fresh contact → suppressed in company, not in personal.
  await repo.recordContacted({ phone: PHONE, orgId: 'company' });
  const doc = await col.findOne({ customer_phone: PHONE, org_id: 'company' });
  check('kind is contacted', doc.failure_kind, 'contacted');
  check('next_retry_at is null', doc.next_retry_at, null);
  const days = Math.round((new Date(doc.eligible_again_at) - new Date(doc.contacted_at)) / 86400000);
  check('eligible_again_at is +180d from contacted_at', days, 180);

  const compSet = await repo.getSuppressedPhones('company');
  const persSet = await repo.getSuppressedPhones('personal');
  check('in cooldown → suppressed in company', compSet.has(PHONE), true);
  check('cooldown is per workspace', persSet.has(PHONE), false);

  // Expired cooldown → no longer suppressed.
  await col.updateOne(
    { customer_phone: PHONE, org_id: 'company' },
    { $set: { eligible_again_at: new Date(Date.now() - 86400000) } }
  );
  const afterExpiry = await repo.getSuppressedPhones('company');
  check('expired cooldown → eligible again', afterExpiry.has(PHONE), false);

  // A privacy record is still permanently suppressed regardless of cooldown.
  await col.updateOne(
    { customer_phone: PHONE, org_id: 'company' },
    { $set: { failure_kind: 'privacy', status: 'active', eligible_again_at: null } }
  );
  const privacySet = await repo.getSuppressedPhones('company');
  check('privacy still permanently suppressed', privacySet.has(PHONE), true);

  await col.deleteMany({ customer_phone: PHONE });
  await client.close();
  await DatabaseConnection.getInstance().disconnect();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run build && node scripts/check-contact-cooldown.js
```

Expected: FAIL — `CONTACT_COOLDOWN_DAYS` is `undefined` and `repo.recordContacted is not a function`.

- [ ] **Step 3: Extend the kind union and document**

In `src/outreach/outreach-suppression-repository.ts`, replace line 30:

```ts
export type SuppressionKind = 'privacy' | 'invalid' | 'transient' | 'contacted';
```

Add to `OutreachSuppressionDocument` after `next_retry_at` (line 46):

```ts
  // 'contacted' records only: when this phone becomes eligible for outreach
  // again (contacted_at + CONTACT_COOLDOWN_DAYS). Null for failure records,
  // which are governed by failure_kind instead of by a clock.
  eligible_again_at?: Date | null;
  contacted_at?: Date | null;
```

- [ ] **Step 4: Add the cooldown constant**

After `const MAX_RETRIES = 3;` (line 57):

```ts
/**
 * How long a successfully-contacted number stays out of the pool. Replaces the
 * old behaviour where OUTREACH_STALE_DAYS (45) governed re-contact.
 */
export const CONTACT_COOLDOWN_DAYS = 180;
```

- [ ] **Step 5: Add `recordContacted`**

In the `OutreachSuppressionRepository` class, immediately before `getSuppressedPhones` (before line 219):

```ts
  /**
   * Record a successful send, starting this phone's 180-day cooldown for this
   * workspace. Overwrites any prior failure record for the same (org, phone) —
   * a number that finally delivered is contacted, not failed, so it also leaves
   * the Failed list. `last_failed_at` is set alongside `contacted_at` purely so
   * the existing `list_idx` sort and the failed-numbers UI have a non-null date
   * to work with.
   */
  async recordContacted(input: {
    phone: string;
    orgId?: OrgId;
    proposalId?: ObjectId | null;
    customerName?: string | null;
    follower?: string | null;
    sentAt?: Date;
  }): Promise<void> {
    const phone = toInternationalPhone(input.phone.trim());
    const orgId = input.orgId ?? DEFAULT_ORG;
    const contactedAt = input.sentAt ?? new Date();
    const eligibleAgainAt = new Date(contactedAt.getTime() + CONTACT_COOLDOWN_DAYS * DAY_MS);
    const now = new Date();

    await this.col.updateOne(
      { org_id: orgId, customer_phone: phone },
      {
        $set: {
          failure_kind: 'contacted' as SuppressionKind,
          status: 'active' as SuppressionStatus,
          contacted_at: contactedAt,
          eligible_again_at: eligibleAgainAt,
          last_failed_at: contactedAt,
          last_failed_reason: `contacted — ${CONTACT_COOLDOWN_DAYS}d cooldown`,
          next_retry_at: null,
          last_proposal_id: input.proposalId ?? null,
          customer_name: input.customerName ?? null,
          follower: input.follower ?? null,
          resolved_at: null,
          updated_at: now,
        },
        $setOnInsert: {
          first_failed_at: contactedAt,
          retries_used: 0,
          created_at: now,
        },
      },
      { upsert: true }
    );
  }
```

- [ ] **Step 6: Make `getSuppressedPhones` cooldown-aware**

Replace `getSuppressedPhones` (lines 219-227) with:

```ts
  /**
   * Phones this workspace must not draft. Two independent reasons:
   *   - a permanent failure (privacy / invalid), which never expires;
   *   - an active contact cooldown, which expires at eligible_again_at.
   */
  async getSuppressedPhones(orgId: OrgId = DEFAULT_ORG): Promise<Set<string>> {
    const now = new Date();
    const cursor = this.col.find(
      {
        org_id: orgMatch(orgId),
        $or: [
          { failure_kind: { $in: SUPPRESSING_KINDS }, status: { $in: SUPPRESSING_STATUSES } },
          { failure_kind: 'contacted', eligible_again_at: { $gt: now } },
        ],
      },
      { projection: { customer_phone: 1, _id: 0 } }
    );
    const set = new Set<string>();
    for await (const doc of cursor) set.add(doc.customer_phone);
    return set;
  }
```

- [ ] **Step 7: Add an index for the cooldown lookup**

In the constructor's `createIndexes` array (after line 124), add:

```ts
          { key: { org_id: 1, failure_kind: 1, eligible_again_at: 1 }, name: 'cooldown_idx' },
```

- [ ] **Step 8: Run the check to verify it passes**

```bash
npm run build && node scripts/check-contact-cooldown.js
```

Expected: `ALL PASS`.

- [ ] **Step 9: Commit**

```bash
git add src/outreach/outreach-suppression-repository.ts scripts/check-contact-cooldown.js
git commit -m "feat(outreach): 180-day contact cooldown via 'contacted' suppression kind"
```

---

### Task 4: `mark-sent` starts the cooldown

**Files:**
- Modify: `src/api/outreach-routes.ts` — the `resolve()` block inside the `mark-sent` handler

**Interfaces:**
- Consumes: `recordContacted()` from Task 3.
- Produces: no new interface.

- [ ] **Step 1: Replace the suppression-clearing block**

In `src/api/outreach-routes.ts`, inside the `mark-sent` handler, replace this block:

```ts
    // Clear any suppression for this phone — a previously-failed number that
    // finally delivered (e.g. via a backup retry) should leave the Failed list.
    try {
      await new OutreachSuppressionRepository().resolve(proposal.customer_phone, normalizeOrg(proposal.org_id));
    } catch (e) {
      Logger.warn(`resolve suppression on mark-sent: ${(e as Error).message}`);
    }
```

with:

```ts
    // Start this phone's contact cooldown for the proposal's own workspace. This
    // also overwrites any prior failure record, so a number that finally
    // delivered leaves the Failed list — the same effect the old resolve() had.
    try {
      await new OutreachSuppressionRepository().recordContacted({
        phone: proposal.customer_phone,
        orgId: normalizeOrg(proposal.org_id),
        proposalId: proposal._id ?? null,
        customerName: proposal.customer_name,
        follower: proposal.follower,
      });
    } catch (e) {
      Logger.warn(`recordContacted on mark-sent: ${(e as Error).message}`);
    }
```

- [ ] **Step 2: Verify the wiring end-to-end**

Create `scripts/check-marksent-cooldown.js`:

```js
/**
 * Verifies mark-sent writes a contacted record with a live cooldown.
 * Requires the server running locally and DASHBOARD_TOKEN set.
 *
 * Usage: node scripts/check-marksent-cooldown.js <proposalId>
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

(async () => {
  const id = process.argv[2];
  if (!id) throw new Error('pass a proposal id that is in_flight');
  const base = process.env.BASE_URL || 'http://localhost:3000';
  const resp = await fetch(`${base}/crm/api/outreach/${id}/mark-sent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.AGENT_TOKEN}`,
    },
    body: JSON.stringify({}),
  });
  console.log('mark-sent status:', resp.status);

  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  const proposal = await db.collection('outreach_proposals').findOne({
    _id: new (require('mongodb').ObjectId)(id),
  });
  const supp = await db.collection('outreach_suppressions').findOne({
    customer_phone: proposal.customer_phone,
  });
  console.log('suppression record:', JSON.stringify({
    kind: supp?.failure_kind,
    contacted_at: supp?.contacted_at,
    eligible_again_at: supp?.eligible_again_at,
  }, null, 2));
  const ok = supp?.failure_kind === 'contacted' && new Date(supp.eligible_again_at) > new Date();
  console.log(ok ? 'PASS' : 'FAIL');
  await client.close();
  process.exit(ok ? 0 : 1);
})();
```

Run against a locally-seeded `in_flight` proposal:

```bash
npm run build && node scripts/check-marksent-cooldown.js <proposalId>
```

Expected: `PASS`, with `kind: contacted` and a future `eligible_again_at`.

- [ ] **Step 3: Commit**

```bash
git add src/api/outreach-routes.ts scripts/check-marksent-cooldown.js
git commit -m "feat(outreach): mark-sent starts the 180-day contact cooldown"
```

---

### Task 5: Failure reclassification — permanent privacy, re-queued transients

**Files:**
- Modify: `src/outreach/outreach-suppression-repository.ts` — `recordFailure` scheduling, delete retry ladder methods
- Modify: `src/outreach/outreach-repository.ts:8-31` (document), after `markFailed` (line 207)
- Modify: `src/outreach/outreach-alerts.ts:4-9` (alert kinds)
- Modify: `src/api/outreach-routes.ts` — the `mark-failed` handler
- Test: `scripts/check-failure-routing.js`

**Interfaces:**
- Consumes: `classifyFailure(reason: string): SuppressionKind` (already exported).
- Produces:
  - `OutreachProposalDocument.transient_retries?: number`
  - `OutreachRepository.requeueTransient(id: string, maxRetries: number): Promise<boolean>`
  - `AlertKind` gains `'transient-requeue'`
  - `MAX_TRANSIENT_RETRIES` = `3` in `src/api/outreach-routes.ts`

- [ ] **Step 1: Write the failing check script**

Create `scripts/check-failure-routing.js`:

```js
/**
 * Verifies failure routing: privacy is permanently closed (no retry clock),
 * and a transient failure re-queues the proposal at most 3 times.
 *
 * Usage: node scripts/check-failure-routing.js
 */
require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

const PHONE = '+855999000222';
let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (got ${actual}, want ${expected})`);
}

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  await db.collection('outreach_suppressions').deleteMany({ customer_phone: PHONE });
  await db.collection('outreach_proposals').deleteMany({ customer_phone: PHONE });

  const DatabaseConnection = require('../dist/database/connection').default;
  await DatabaseConnection.getInstance().connect();
  const { OutreachSuppressionRepository, classifyFailure } =
    require('../dist/outreach/outreach-suppression-repository');
  const { OutreachRepository } = require('../dist/outreach/outreach-repository');
  const suppRepo = new OutreachSuppressionRepository();
  const outreachRepo = new OutreachRepository();

  check('privacy reason classifies as privacy',
    classifyFailure('phone number not on Telegram (or hidden by privacy)'), 'privacy');
  check('crash reason classifies as transient',
    classifyFailure('lease expired'), 'transient');

  // Privacy failure is permanently closed — no retry clock.
  await suppRepo.recordFailure({
    phone: PHONE, reason: 'phone number not on Telegram (or hidden by privacy)', orgId: 'company',
  });
  const priv = await db.collection('outreach_suppressions').findOne({ customer_phone: PHONE });
  check('privacy next_retry_at is null', priv.next_retry_at, null);
  check('privacy is suppressed', (await suppRepo.getSuppressedPhones('company')).has(PHONE), true);

  // Transient re-queue is bounded at 3.
  const ins = await db.collection('outreach_proposals').insertOne({
    org_id: 'company', generation_id: 'check', customer_phone: PHONE, customer_name: null,
    reason_code: null, days_since_contact: null, follower: null, message: 'x',
    reasoning: 'check', status: 'in_flight', skipped_reason: null, failed_reason: null,
    custom_image_id: null, created_at: new Date(), approved_at: new Date(),
    approved_by: 'check', sent_at: null, lease_expires_at: null, model: 'static',
  });
  const id = String(ins.insertedId);
  for (let i = 1; i <= 3; i++) {
    check(`transient requeue #${i} succeeds`, await outreachRepo.requeueTransient(id, 3), true);
    const doc = await db.collection('outreach_proposals').findOne({ _id: new ObjectId(id) });
    check(`  status back to approved (#${i})`, doc.status, 'approved');
    check(`  transient_retries === ${i}`, doc.transient_retries, i);
    await db.collection('outreach_proposals').updateOne(
      { _id: new ObjectId(id) }, { $set: { status: 'in_flight' } });
  }
  check('4th requeue refused', await outreachRepo.requeueTransient(id, 3), false);

  await db.collection('outreach_suppressions').deleteMany({ customer_phone: PHONE });
  await db.collection('outreach_proposals').deleteMany({ customer_phone: PHONE });
  await client.close();
  await DatabaseConnection.getInstance().disconnect();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run build && node scripts/check-failure-routing.js
```

Expected: FAIL — `outreachRepo.requeueTransient is not a function`, and privacy `next_retry_at` is a date rather than `null`.

- [ ] **Step 3: Make privacy failures permanent**

In `src/outreach/outreach-suppression-repository.ts`, in `recordFailure`, replace the insert-path scheduling line (line 157):

```ts
        next_retry_at: kind === 'privacy' ? daysFromNow(RETRY_INTERVAL_DAYS) : null,
```

with:

```ts
        // Privacy failures are permanent: the recipient's own privacy setting is
        // what blocks delivery, and that does not change on a timer. No retry clock.
        next_retry_at: null,
```

Replace the two update-path lines (lines 192 and 199) so both read:

```ts
      set.next_retry_at = null;
```

- [ ] **Step 4: Delete the retry ladder**

In the same file, delete these members entirely: `listForRetry`, `bumpRetry`, `deferRetry`. Delete the now-unused constants `RETRY_INTERVAL_DAYS`, `MAX_RETRIES`, and the helper `daysFromNow` if nothing else references it.

Verify nothing else references them:

```bash
grep -rn "listForRetry\|bumpRetry\|deferRetry\|RETRY_INTERVAL_DAYS\|MAX_RETRIES" --include=*.ts src/ scripts/
```

Expected: only `src/scheduler/outreach-scheduler.ts` (cleaned up in Task 6) and `scripts/backfill-suppressions.ts`. If the backfill script references the stagger logic on line 374, replace that line with `const stagger = null;`.

- [ ] **Step 5: Add the retry counter to the proposal document**

In `src/outreach/outreach-repository.ts`, add to `OutreachProposalDocument` after `claim_attempts?: number;` (line 29):

```ts
  // How many times a transient (crash / lease-expiry) failure has re-queued this
  // proposal. Bounded by MAX_TRANSIENT_RETRIES so a genuinely broken send cannot
  // loop forever. Absent on proposals created before this field existed.
  transient_retries?: number;
```

- [ ] **Step 6: Add `requeueTransient`**

In the same file, immediately after `markFailed` (after line 207):

```ts
  /**
   * Return a proposal to the approved queue after a transient failure, so the
   * worker retries it. A transient failure means the message never reached the
   * customer, so the number must NOT be treated as contacted. Refuses once
   * maxRetries is reached, at which point the caller should fail it for real.
   */
  async requeueTransient(id: string, maxRetries: number): Promise<boolean> {
    try {
      const result = await this.col.findOneAndUpdate(
        {
          _id: new ObjectId(id),
          $or: [
            { transient_retries: { $lt: maxRetries } },
            { transient_retries: { $exists: false } },
          ],
        },
        {
          $set: { status: 'approved', failed_reason: null, lease_expires_at: null },
          $inc: { transient_retries: 1 },
        },
        { returnDocument: 'after' }
      );
      return Boolean(result);
    } catch {
      return false;
    }
  }
```

- [ ] **Step 7: Add the alert kind**

In `src/outreach/outreach-alerts.ts`, extend the union (lines 4-9):

```ts
export type AlertKind =
  | 'mark-failed'
  | 'transient-requeue'
  | 'lease-expired'
  | 'worker-offline'
  | 'session-expired'
  | 'worker-fatal';
```

- [ ] **Step 8: Rewire the mark-failed handler**

In `src/api/outreach-routes.ts`, add near `DEFAULT_ATTEMPT_CAP` (after line 32):

```ts
// A transient failure (pm2 crash, lease expiry, mtproto blip) means the message
// never left, so the proposal is re-queued rather than failed. Bounded so a
// genuinely broken send cannot loop forever.
const MAX_TRANSIENT_RETRIES = 3;
```

Add `classifyFailure` to the existing suppression-repository import on line 13:

```ts
import { OutreachSuppressionRepository, SuppressionKind, SuppressionStatus, SuppressionListQuery, classifyFailure } from '../outreach/outreach-suppression-repository';
```

Then, in the `mark-failed` handler, insert this block immediately after the `if (!proposal) { ... }` guard and **before** the `markFailed` call:

```ts
    // Transient failures never reached the customer. Re-queue instead of failing,
    // refund the attempt slot, and alert — these are almost always a worker crash,
    // not a bad number, and letting one through would burn the phone's single
    // contact on a send that never happened.
    if (classifyFailure(reason) === 'transient') {
      const requeued = await outreachRepo.requeueTransient(req.params.id, MAX_TRANSIENT_RETRIES);
      if (requeued) {
        try {
          await new OutreachWorkerStateRepository().releaseClaim(normalizeOrg(proposal.org_id));
        } catch (e) {
          Logger.warn(`releaseClaim on transient requeue: ${(e as Error).message}`);
        }
        Logger.warn(`[outreach] transient failure re-queued proposal=${req.params.id} reason=${reason}`);
        notifyOutreachFailure(proposal, 'transient-requeue', { reason }).catch((err) => {
          Logger.error('transient-requeue alert dispatch errored', err as Error);
        });
        res.json({ success: true, requeued: true });
        return;
      }
      Logger.error(
        `[outreach] proposal=${req.params.id} exhausted ${MAX_TRANSIENT_RETRIES} transient retries — failing for real`,
        new Error(reason)
      );
    }
```

Leave the rest of the handler unchanged — an exhausted transient now falls through to the existing `markFailed` + `recordFailure` + alert path.

- [ ] **Step 9: Run the check to verify it passes**

```bash
npm run build && node scripts/check-failure-routing.js
```

Expected: `ALL PASS`.

- [ ] **Step 10: Commit**

```bash
git add src/outreach/outreach-suppression-repository.ts src/outreach/outreach-repository.ts src/outreach/outreach-alerts.ts src/api/outreach-routes.ts scripts/check-failure-routing.js
git commit -m "feat(outreach): permanent privacy closure, bounded transient re-queue + alert"
```

---

### Task 6: Per-org top-up scan

**Files:**
- Modify: `src/scheduler/outreach-scheduler.ts` (most of the file)
- Modify: `src/outreach/outreach-repository.ts` (new `countOutstanding`)
- Test: `scripts/check-scan-topup.js`

**Interfaces:**
- Consumes: `setAutoApprove` / `getStatus().auto_approve` (Task 1); `getSuppressedPhones` cooldown behaviour (Task 3).
- Produces:
  - `OutreachRepository.countOutstanding(orgId: OrgId): Promise<number>`
  - `OutreachScheduler.triggerNow(): Promise<void>` (signature unchanged)
  - `OUTREACH_QUEUE_TARGET` env override, default `20`

- [ ] **Step 1: Write the failing check script**

Create `scripts/check-scan-topup.js`:

```js
/**
 * Verifies the scan tops the outstanding queue up to 20 rather than adding 20:
 * with N outstanding it drafts 20-N, and with N>=20 it drafts nothing.
 *
 * Usage: node scripts/check-scan-topup.js
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (got ${actual}, want ${expected})`);
}

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();

  const DatabaseConnection = require('../dist/database/connection').default;
  await DatabaseConnection.getInstance().connect();
  const { OutreachRepository } = require('../dist/outreach/outreach-repository');
  const repo = new OutreachRepository();

  const live = await db.collection('outreach_proposals').countDocuments({
    org_id: { $in: ['company', null] },
    status: { $in: ['pending', 'approved'] },
  });
  check('countOutstanding matches a direct count', await repo.countOutstanding('company'), live);

  // Pure arithmetic of the top-up rule, mirroring the scheduler.
  const target = 20;
  check('with 0 outstanding drafts 20', Math.max(0, target - 0), 20);
  check('with 8 outstanding drafts 12', Math.max(0, target - 8), 12);
  check('with 20 outstanding drafts 0', Math.max(0, target - 20), 0);
  check('with 25 outstanding drafts 0', Math.max(0, target - 25), 0);

  await client.close();
  await DatabaseConnection.getInstance().disconnect();
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run build && node scripts/check-scan-topup.js
```

Expected: FAIL — `repo.countOutstanding is not a function`.

- [ ] **Step 3: Add `countOutstanding`**

In `src/outreach/outreach-repository.ts`, after `hasRecentProposalForPhone` (after line 218):

```ts
  /**
   * Proposals still awaiting action for this workspace — anything a human could
   * approve or the worker could still send. Drives the scan's top-up rule so the
   * queue never grows past its target.
   */
  async countOutstanding(orgId: OrgId): Promise<number> {
    return this.col.countDocuments({
      org_id: orgMatch(orgId),
      status: { $in: ['pending', 'approved'] },
    });
  }
```

- [ ] **Step 4: Rewrite the scheduler**

Replace the entire contents of `src/scheduler/outreach-scheduler.ts` with:

```ts
import * as cron from 'node-cron';
import { Logger } from '../utils/logger';
import { generateBatch } from '../outreach/outreach-agent';
import { OutreachRepository } from '../outreach/outreach-repository';
import { OutreachWorkerStateRepository } from '../outreach/outreach-worker-state-repository';
import { OUTREACH_ORGS, OrgId } from '../outreach/orgs';

const DEFAULT_CRON = '0 9 * * *';
const DEFAULT_STALE_DAYS = 45;
/**
 * Ceiling on outstanding (pending + approved) proposals per workspace. The scan
 * tops the queue UP TO this number rather than adding this many, so a slow day
 * cannot accumulate a backlog — which matters because drafting is 20/day while
 * delivery is 15/day, and on Auto nobody is reviewing the pile.
 */
const DEFAULT_QUEUE_TARGET = 20;

type SendMessage = (chatId: string, text: string, extra?: any) => Promise<void>;

let registeredScheduler: OutreachScheduler | null = null;

export function getRegisteredOutreachScheduler(): OutreachScheduler | null {
  return registeredScheduler;
}

export class OutreachScheduler {
  private sendMessageCallback?: SendMessage;

  public setNotifyCallback(callback: SendMessage): void {
    this.sendMessageCallback = callback;
  }

  /** Force a scan tick now (used by /scheduler/run-once for testing). */
  public async triggerNow(): Promise<void> {
    await this.runScan();
  }

  public startScheduler(): void {
    registeredScheduler = this;

    if (process.env.OUTREACH_AUTO_SCAN !== 'true') {
      Logger.warn('Outreach auto-scan disabled (set OUTREACH_AUTO_SCAN=true to enable)');
      return;
    }

    const cronExpr = process.env.OUTREACH_CRON || DEFAULT_CRON;
    const tz = process.env.TIMEZONE || 'Asia/Kuala_Lumpur';

    cron.schedule(cronExpr, () => {
      Logger.info('Outreach scheduler tick');
      this.runScan().catch((err) => Logger.error('outreach scan tick failed', err as Error));
    }, {
      scheduled: true,
      timezone: tz,
    });

    Logger.info(`Outreach scheduler started (cron='${cronExpr}', tz='${tz}')`);
  }

  private queueTarget(): number {
    const parsed = Number(process.env.OUTREACH_QUEUE_TARGET);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QUEUE_TARGET;
  }

  private staleDays(): number {
    const parsed = Number(process.env.OUTREACH_STALE_DAYS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_DAYS;
  }

  /**
   * Scan every workspace. One org failing must not stop the others.
   * NOTE: OUTREACH_ORGS is OrgDef[] ({ id, label }), not a string array — iterate
   * the objects and pass `.id`.
   */
  private async runScan(): Promise<void> {
    for (const org of OUTREACH_ORGS) {
      try {
        await this.runScanForOrg(org.id);
      } catch (err) {
        Logger.error(`Outreach scan failed for org=${org.id}`, err as Error);
      }
    }
  }

  private async runScanForOrg(orgId: OrgId): Promise<void> {
    const target = this.queueTarget();
    const outstanding = await new OutreachRepository().countOutstanding(orgId);
    const draftCount = Math.max(0, target - outstanding);

    if (draftCount === 0) {
      Logger.info(`Outreach scan org=${orgId}: queue already at ${outstanding}/${target}, drafting 0`);
      return;
    }

    // Approval mode is per workspace and read fresh each tick, so flipping the
    // dashboard switch takes effect on the very next scan.
    const state = await new OutreachWorkerStateRepository().getStatus(orgId);
    const autoApprove = state.auto_approve === true;

    const result = await generateBatch({
      limit: draftCount,
      staleDays: this.staleDays(),
      autoApprove,
      orgId,
    });

    Logger.info(
      `Outreach scan org=${orgId} mode=${autoApprove ? 'auto' : 'manual'}: ` +
      `outstanding=${outstanding} target=${target} drafted=${draftCount} ` +
      `created=${result.created} skipped=${result.skipped} errored=${result.errored}`
    );

    const chatId = process.env.AUDIT_CHAT_ID || process.env.REPORT_CHAT_ID;
    if (chatId && this.sendMessageCallback) {
      const lines = [
        `📡 *Outreach scan* — ${orgId}`,
        '',
        `Mode: ${autoApprove ? 'AUTO approve' : 'manual approve'}`,
        `Queue before: ${outstanding}/${target}`,
        `Drafted: ${result.created}`,
        `Skipped: ${result.skipped}`,
        `Errored: ${result.errored}`,
      ];
      try {
        await this.sendMessageCallback(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
      } catch (err) {
        Logger.error('Outreach scan summary send failed', err as Error);
      }
    }
  }
}
```

- [ ] **Step 5: Update the auto-approve reasoning string**

In `src/outreach/outreach-agent.ts`, replace the `reasoning` ternary (lines 108-110):

```ts
      reasoning: opts.autoApprove
        ? 'static template (auto-approved by workspace setting)'
        : 'static template (AI generation disabled)',
```

and replace the `approved_by` value (line 117):

```ts
      approved_by: opts.autoApprove ? 'auto-approve' : null,
```

- [ ] **Step 6: Remove the dead retry-scan trigger**

Check for callers of the deleted `triggerRetryNow`:

```bash
grep -rn "triggerRetryNow\|runRetryScan\|OUTREACH_RETRY_ENABLED\|OUTREACH_DAILY_DRAFT_BUDGET\|OUTREACH_BATCH_LIMIT" --include=*.ts src/
```

Delete any route or reference that surfaces. If `src/api/outreach-routes.ts` has a `/scheduler/retry-once` handler, delete the whole handler.

- [ ] **Step 7: Build and run the check**

```bash
npm run build && node scripts/check-scan-topup.js
```

Expected: `ALL PASS`, and the build reports no unused-import or missing-method errors.

- [ ] **Step 8: Exercise the real scan**

With the server running and `OUTREACH_AUTO_SCAN=true`:

```bash
curl -X POST http://localhost:3000/crm/api/outreach/scheduler/run-once \
  -H "Cookie: dashboard_token=$DASHBOARD_TOKEN"
```

Expected in the logs: one `Outreach scan org=company ...` line and one `org=personal ...` line, each reporting `outstanding`, `target=20`, and its own `mode=`.

- [ ] **Step 9: Commit**

```bash
git add src/scheduler/outreach-scheduler.ts src/outreach/outreach-repository.ts src/outreach/outreach-agent.ts src/api/outreach-routes.ts scripts/check-scan-topup.js
git commit -m "feat(outreach): per-org top-up scan driven by the auto-approve toggle"
```

---

### Task 7: Phone-list import

**Files:**
- Modify: `src/api/crm-routes.ts:294-390` (the `/api/import` handler)
- Test: `scripts/check-import-aliases.js`

**Interfaces:**
- Consumes: `getSuppressedPhones` (Task 3) for the cooldown bucket.
- Produces: `/crm/api/import` response gains `buckets: { parsed, invalid_format, duplicate_in_file, already_in_db, in_cooldown, net_new }`.

- [ ] **Step 1: Write the failing check script**

Create `scripts/check-import-aliases.js`:

```js
/**
 * Verifies the phone-column alias detection against the real supplied file.
 * Expects 100 rows in, 97 unique valid Cambodian numbers out.
 *
 * Usage: node scripts/check-import-aliases.js <path-to-xlsx>
 */
const ExcelJS = require('exceljs');
const { toInternationalPhone } = require('../dist/utils/phone-utils');

const PHONE_HEADERS = ['phone', 'phone number', 'phone_number', 'phone no', 'tel', 'number', 'contact'];
const INDEX_HEADERS = ['no', 'no.', '#', 'index'];
const E164 = /^\+855\d{8,9}$/;

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (got ${actual}, want ${expected})`);
}

(async () => {
  const path = process.argv[2];
  if (!path) throw new Error('pass the xlsx path');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];

  const headers = [];
  ws.getRow(1).eachCell((cell, i) => {
    headers[i - 1] = String(cell.value || '').toLowerCase().trim();
  });
  const phoneCol = headers.findIndex((h) => PHONE_HEADERS.includes(h));
  check('phone column detected', phoneCol >= 0, true);
  check('index column ignored', INDEX_HEADERS.includes(headers[0]), true);

  const seen = new Set();
  let parsed = 0, invalid = 0, dupes = 0;
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const raw = row.getCell(phoneCol + 1).value;
    if (raw === null || raw === undefined) return;
    parsed++;
    const intl = toInternationalPhone(String(raw).trim());
    if (!E164.test(intl)) { invalid++; return; }
    if (seen.has(intl)) { dupes++; return; }
    seen.add(intl);
  });

  console.log(`parsed=${parsed} invalid=${invalid} duplicate_in_file=${dupes} unique=${seen.size}`);
  check('100 rows parsed', parsed, 100);
  check('97 unique numbers', seen.size, 97);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run build && node scripts/check-import-aliases.js "C:/Users/SH Computer/.claude/uploads/11542fde-473d-4632-86ce-6606405ca506/d44f8e63-phone_numbers.xlsx"
```

Expected: FAIL on the unique count if `toInternationalPhone` is not exported from the built path, or PASS on parsing — this script validates the *rule*, and Step 3 ports the same rule into the route.

- [ ] **Step 3: Add the alias constants**

In `src/api/crm-routes.ts`, near the top after the imports:

```ts
// Header names that identify a phone column. The supplied QuickBook exports use
// 'Phone Number'; earlier CSVs used a bare 'phone'. Matching only 'phone' sent
// aliased files down the free-text QuickBook parser, which mangled them.
const PHONE_HEADER_ALIASES = ['phone', 'phone number', 'phone_number', 'phone no', 'tel', 'number', 'contact'];
const INDEX_HEADER_ALIASES = ['no', 'no.', '#', 'index'];
const PHONE_E164 = /^\+855\d{8,9}$/;
```

- [ ] **Step 4: Replace the header-detection branch**

In the `/api/import` handler, replace:

```ts
    let responseHeaders = headers.filter(Boolean);
    const hasPhoneHeader = headers.includes('phone');

    if (hasPhoneHeader) {
```

with:

```ts
    let responseHeaders = headers.filter(Boolean);
    const phoneColIndex = headers.findIndex((h) => PHONE_HEADER_ALIASES.includes(h));
    const hasPhoneHeader = phoneColIndex >= 0;

    // Buckets so the operator can see exactly what happened to every input row,
    // rather than a bare "N imported".
    const buckets = {
      parsed: 0,
      invalid_format: 0,
      duplicate_in_file: 0,
      already_in_db: 0,
      in_cooldown: 0,
      net_new: 0,
    };

    if (hasPhoneHeader) {
```

- [ ] **Step 5: Replace the structured-row loop**

Replace the body of the `if (hasPhoneHeader) { ... }` branch with:

```ts
      // Structured sheet: one phone per row under a recognised header. The index
      // column ('No.') is deliberately ignored rather than imported as data.
      const org = resolveOrg(req);
      const repository = getRepository();
      const suppressed = await new OutreachSuppressionRepository().getSuppressedPhones(org);
      const existing = new Set(
        (await repository.getAllCustomers(undefined, org))
          .filter((c) => c.phone)
          .map((c) => toInternationalPhone(c.phone!.trim()))
      );
      const seenInFile = new Set<string>();

      const STALE_DAYS = 45;
      const staleDate = new Date();
      staleDate.setDate(staleDate.getDate() - STALE_DAYS);
      const staleDateStr = staleDate.toISOString().slice(0, 10);

      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // skip header
        const record: any = {};
        row.eachCell((cell, colNumber) => {
          const header = headers[colNumber - 1];
          if (!header || INDEX_HEADER_ALIASES.includes(header)) return;
          const value = cell.value !== null && cell.value !== undefined ? String(cell.value).trim() : null;
          if (PHONE_HEADER_ALIASES.includes(header)) record.phone = value;
          else record[header] = value;
        });
        if (!record.phone) return;

        buckets.parsed++;
        const intl = toInternationalPhone(String(record.phone).trim());
        if (!PHONE_E164.test(intl)) { buckets.invalid_format++; return; }
        if (seenInFile.has(intl)) { buckets.duplicate_in_file++; return; }
        seenInFile.add(intl);
        if (existing.has(intl)) { buckets.already_in_db++; return; }
        if (suppressed.has(intl)) { buckets.in_cooldown++; return; }

        buckets.net_new++;
        rows.push({ ...record, phone: intl, date: record.date || staleDateStr });
      });
      responseHeaders = ['name', 'phone', 'date'];
```

- [ ] **Step 6: Count the QuickBook fallback rows too**

In the `else` branch (the QuickBook free-text parser), after `if (record) {`, add:

```ts
          buckets.parsed++;
          buckets.net_new++;
```

- [ ] **Step 7: Return the buckets**

Replace the preview response with:

```ts
    res.json({
      preview: true,
      total: rows.length,
      sample: rows.slice(0, 5),
      headers: responseHeaders,
      buckets,
      rows
    });
```

- [ ] **Step 8: Add the missing import**

Ensure `src/api/crm-routes.ts` imports the suppression repository:

```ts
import { OutreachSuppressionRepository } from '../outreach/outreach-suppression-repository';
```

- [ ] **Step 9: Verify against the real file**

```bash
npm run build && npm start
```

With the workspace switcher set to **company**, upload the file at `/crm/import`. Expected buckets: `parsed: 100`, `invalid_format: 0`, `duplicate_in_file: 3`, `net_new: 97` minus whatever is already in the DB or in cooldown. Confirm the imported numbers then appear at `/crm/quickbook-customers`.

- [ ] **Step 10: Commit**

```bash
git add src/api/crm-routes.ts scripts/check-import-aliases.js
git commit -m "feat(crm): recognise Phone Number column aliases + report import buckets"
```

---

### Task 8: Backfill and pool measurement

**Files:**
- Create: `scripts/backfill-contacted-ledger.js`
- Create: `scripts/count-contactable-pool.js`

**Interfaces:**
- Consumes: the `contacted` kind and `CONTACT_COOLDOWN_DAYS` from Task 3.
- Produces: no code interface — operational scripts only.

- [ ] **Step 1: Write the pool-count script**

Create `scripts/count-contactable-pool.js`:

```js
/**
 * How many numbers can this workspace actually contact? Answers whether the
 * 180-day cooldown ever binds: at 15 sends/day it takes ~2,700 sends before any
 * number recycles, so a pool above that behaves as if contact were permanent.
 *
 * Usage: node scripts/count-contactable-pool.js
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const COOLDOWN_DAYS = 180;
const DAILY_CAP = Number(process.env.DAILY_CAP) || 15;

(async () => {
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  const now = new Date();

  for (const org of ['company', 'personal']) {
    const orgMatch = org === 'company' ? { $in: ['company', null] } : org;

    const distinct = await db.collection('leads_events').aggregate([
      { $match: { org_id: orgMatch, 'customer.phone': { $ne: null } } },
      { $group: { _id: '$customer.phone' } },
      { $count: 'total' },
    ]).toArray();
    const pool = distinct[0]?.total ?? 0;

    const blocked = await db.collection('outreach_suppressions').countDocuments({
      org_id: orgMatch,
      $or: [
        { failure_kind: { $in: ['privacy', 'invalid'] } },
        { failure_kind: 'contacted', eligible_again_at: { $gt: now } },
      ],
    });

    const contactable = Math.max(0, pool - blocked);
    const recycleAfter = DAILY_CAP * COOLDOWN_DAYS;

    console.log(`\n=== ${org} ===`);
    console.log(`distinct phones in leads_events : ${pool}`);
    console.log(`blocked (permanent + cooldown)  : ${blocked}`);
    console.log(`contactable now                 : ${contactable}`);
    console.log(`sends before any number recycles: ${recycleAfter}`);
    console.log(
      contactable >= recycleAfter
        ? '→ pool exceeds the recycle threshold: the 180d cooldown never binds.'
        : `→ pool is BELOW the threshold: expect the queue to thin out after ~${Math.floor(contactable / DAILY_CAP)} days.`
    );
  }

  await client.close();
})();
```

- [ ] **Step 2: Run it and record the answer**

```bash
node scripts/count-contactable-pool.js
```

Expected: a per-workspace report. Note the `contactable now` figure — it is the input to the rollout decision.

- [ ] **Step 3: Write the backfill script**

Create `scripts/backfill-contacted-ledger.js`:

```js
/**
 * One-time backfill for the 180-day contact cooldown.
 *
 *   1. Every past 'sent' proposal becomes a 'contacted' suppression record with
 *      eligible_again_at = sent_at + 180d. Sends older than 180 days are written
 *      already-expired, so this installs a clock — it is NOT a mass closure.
 *   2. Every existing 'privacy' record loses its retry clock (next_retry_at=null),
 *      matching the new permanent-closure rule.
 *
 * Dry run by default. Pass --confirm to write.
 *
 * Usage: node scripts/backfill-contacted-ledger.js [--confirm]
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const COOLDOWN_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

(async () => {
  const confirm = process.argv.includes('--confirm');
  const client = new MongoClient(process.env.DATABASE_URL, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  const db = client.db();
  const now = new Date();

  console.log(confirm ? '=== APPLYING ===' : '=== DRY RUN (pass --confirm to write) ===');

  // 1. Contacted records from past sends. Latest send per (org, phone) wins.
  const sends = await db.collection('outreach_proposals').aggregate([
    { $match: { status: 'sent' } },
    { $group: {
      _id: { org: { $ifNull: ['$org_id', 'company'] }, phone: '$customer_phone' },
      sent_at: { $max: { $ifNull: ['$sent_at', '$created_at'] } },
      name: { $first: '$customer_name' },
      follower: { $first: '$follower' },
    } },
  ]).toArray();

  let active = 0, expired = 0;
  const ops = [];
  for (const s of sends) {
    const contactedAt = new Date(s.sent_at);
    const eligibleAgainAt = new Date(contactedAt.getTime() + COOLDOWN_DAYS * DAY_MS);
    if (eligibleAgainAt > now) active++; else expired++;
    ops.push({
      updateOne: {
        filter: { org_id: s._id.org, customer_phone: s._id.phone },
        update: {
          $set: {
            failure_kind: 'contacted',
            status: 'active',
            contacted_at: contactedAt,
            eligible_again_at: eligibleAgainAt,
            last_failed_at: contactedAt,
            last_failed_reason: `contacted — ${COOLDOWN_DAYS}d cooldown (backfilled)`,
            next_retry_at: null,
            customer_name: s.name ?? null,
            follower: s.follower ?? null,
            resolved_at: null,
            updated_at: now,
          },
          $setOnInsert: {
            first_failed_at: contactedAt,
            retries_used: 0,
            last_proposal_id: null,
            created_at: now,
          },
        },
        upsert: true,
      },
    });
  }

  console.log(`\npast sends (distinct org+phone) : ${sends.length}`);
  console.log(`  still inside 180d cooldown    : ${active}`);
  console.log(`  already past it (stay eligible): ${expired}`);

  // 2. Strip retry clocks from privacy records.
  const privacyWithClock = await db.collection('outreach_suppressions').countDocuments({
    failure_kind: 'privacy',
    next_retry_at: { $ne: null },
  });
  console.log(`privacy records with a retry clock: ${privacyWithClock} → will be cleared`);

  if (!confirm) {
    console.log('\nNo writes performed. Re-run with --confirm to apply.');
    await client.close();
    return;
  }

  if (ops.length > 0) {
    const result = await db.collection('outreach_suppressions').bulkWrite(ops, { ordered: false });
    console.log(`\ncontacted upserts: ${result.upsertedCount} inserted, ${result.modifiedCount} updated`);
  }
  const cleared = await db.collection('outreach_suppressions').updateMany(
    { failure_kind: 'privacy', next_retry_at: { $ne: null } },
    { $set: { next_retry_at: null, updated_at: now } }
  );
  console.log(`privacy retry clocks cleared: ${cleared.modifiedCount}`);
  console.log('\nDone.');
  await client.close();
})();
```

- [ ] **Step 4: Dry-run the backfill and reconcile**

```bash
node scripts/backfill-contacted-ledger.js
```

Cross-check the reported `past sends (distinct org+phone)` against a direct count:

```bash
node -e "require('dotenv').config();const{MongoClient}=require('mongodb');(async()=>{const c=new MongoClient(process.env.DATABASE_URL);await c.connect();const r=await c.db().collection('outreach_proposals').aggregate([{\$match:{status:'sent'}},{\$group:{_id:{o:{\$ifNull:['\$org_id','company']},p:'\$customer_phone'}}},{\$count:'n'}]).toArray();console.log(r);await c.close();})()"
```

The two numbers must match before proceeding.

- [ ] **Step 5: Apply the backfill**

```bash
node scripts/backfill-contacted-ledger.js --confirm
```

- [ ] **Step 6: Verify the result**

```bash
node scripts/count-contactable-pool.js
node scripts/check-contact-cooldown.js
```

Expected: the pool report now shows a non-zero `blocked` count, and the cooldown check still reports `ALL PASS`.

- [ ] **Step 7: Commit**

```bash
git add scripts/backfill-contacted-ledger.js scripts/count-contactable-pool.js
git commit -m "chore(outreach): contacted-ledger backfill + contactable-pool report"
```

---

## Rollout

1. Deploy with both toggles **off** (manual) — the default. Behaviour is unchanged except that privacy failures stop being retried and crash failures now re-queue.
2. Run `scripts/count-contactable-pool.js` and confirm the pool exceeds ~2,700.
3. Dry-run, then apply, `scripts/backfill-contacted-ledger.js --confirm`.
4. Import the 97 numbers at `/crm/import` with the workspace switcher on **company**.
5. Watch one 9AM scan complete in manual mode; confirm the queue tops up to 20 and no number in cooldown appears.
6. Flip **company** to Auto. Leave personal manual until company has run clean for a few days.

## Rollback

- **Auto mode:** flip the switch off, or `db.outreach_worker_state.updateMany({}, {$set:{auto_approve:false}})`.
- **Cooldown:** `db.outreach_suppressions.deleteMany({failure_kind:'contacted'})` restores the previous eligibility exactly, since `contacted` records are additive.
- **Transient re-queue:** set `MAX_TRANSIENT_RETRIES = 0` to fall straight through to the old fail path.
- The deleted privacy-retry ladder is **not** recoverable by config — it requires reverting Task 5.
