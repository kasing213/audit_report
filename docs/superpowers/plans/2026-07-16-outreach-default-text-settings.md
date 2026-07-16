# Editable Default Outreach Text — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the default outreach message text the same edit-from-the-UI CRUD the default image and video already have, persisted in the database.

**Architecture:** A new singleton-doc Mongo repository stores the operator-edited message. The existing `getStaticOutreachMessage()` becomes an async resolver with precedence DB → env → hardcoded constant. Three new API routes (GET/POST/DELETE `/default-text`) back a new "Default text" card on `/crm/outreach`, styled to match the image/video cards.

**Tech Stack:** TypeScript, Express, MongoDB (native driver), Handlebars templates. No test framework is configured in this repo — verification is `npm run typecheck` plus driving the running CRM.

## Global Constraints

- **Verification model:** this repo has NO test runner (no jest/vitest/mocha). Per-task verification is `npm run typecheck` (runs `tsc --noEmit`) plus the manual check described in the task. Do not add a test framework.
- **Precedence (verbatim from spec):** DB value → `OUTREACH_STATIC_MESSAGE` env → hardcoded `DEFAULT_STATIC_MESSAGE`.
- **Effect timing:** editing default text affects only newly generated proposals; existing proposals are never rewritten.
- **Auth:** new routes use `authMiddleware` only (already applied router-wide in `outreach-routes.ts`) — no extra role gate, matching the media routes.
- **Max message length:** 4096 characters (Telegram send limit).
- **Mongo singleton pattern:** follow `OutreachVideoRepository` — collection with one fixed doc `_id: 'default'`, obtain the DB via `DatabaseConnection.getInstance().getDb()`.
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: OutreachSettingsRepository

**Files:**
- Create: `src/outreach/outreach-settings-repository.ts`

**Interfaces:**
- Consumes: `DatabaseConnection` from `../database/connection` (default export, `getInstance().getDb()`); `Logger` from `../utils/logger`.
- Produces:
  - `class OutreachSettingsRepository`
  - `getStaticMessage(): Promise<string | null>`
  - `setStaticMessage(text: string, updatedBy: string): Promise<void>`
  - `clearStaticMessage(): Promise<void>`

- [ ] **Step 1: Create the repository file**

```typescript
// src/outreach/outreach-settings-repository.ts
/**
 * Stores operator-editable outreach settings as a single singleton doc
 * (`_id: 'default'`) in the `outreach_settings` collection. Currently holds
 * just the default static outreach message. Mirrors the singleton-doc shape of
 * OutreachVideoRepository.
 */
import { Collection } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { Logger } from '../utils/logger';

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
    const res = await this.col.deleteOne({ _id: DEFAULT_ID } as any);
    if (res.deletedCount !== 1) {
      Logger.warn('outreach_settings clearStaticMessage: no default doc to delete (already absent)');
    }
  }
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS (no errors). If `DatabaseConnection`'s default-export shape differs, open `src/outreach/outreach-video-repository.ts` and copy its exact import/usage — this repo must match it.

- [ ] **Step 3: Commit**

```bash
git add src/outreach/outreach-settings-repository.ts
git commit -m "Add OutreachSettingsRepository for editable default text

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Async resolver in static-template.ts

**Files:**
- Modify: `src/outreach/static-template.ts` (whole file)

**Interfaces:**
- Consumes: `OutreachSettingsRepository.getStaticMessage()` from Task 1; `Logger` from `../utils/logger`.
- Produces:
  - `getStaticOutreachMessage(): Promise<string>` (was sync `: string`)
  - `DEFAULT_STATIC_MESSAGE: string` (now exported, unchanged value)

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `src/outreach/static-template.ts` with:

```typescript
// Default outreach message used while AI generation is disabled.
// Sent verbatim as the image caption to every selected lead.
// Resolution order: DB value (edited from the CRM) → OUTREACH_STATIC_MESSAGE
// env override → the committed DEFAULT_STATIC_MESSAGE below. The committed
// default means no config is required to ship.
import { OutreachSettingsRepository } from './outreach-settings-repository';
import { Logger } from '../utils/logger';

export const DEFAULT_STATIC_MESSAGE = [
  'ជម្រាបសួរបង 🙏',
  'ប្អូនឈ្មោះ ធឿន ធារី ជាបុគ្គលិកផ្នែកលក់ប្រចាំគម្រោងដែលមានទីតាំងស្ថិតនៅ ផ្លូវជាតិលេខ៣ ម្តុំវត្តស្លែង ខណ្ឌដង្កោ រាជធានីភ្នំពេញ។',
  ' ប្រសិនបើបងមានចំណាប់អារម្មណ៍លើដីឡូតិ៍ ផ្ទះអាជីវកម្ម ផ្ទះរូប ឬចង់សាកសួរព័ត៌មានបន្ថែមអំពីគម្រោង ប្អូនរីករាយផ្តល់ព័ត៌មាន និងប្រឹក្សាជូនបងបាន',
  'សូមអរគុណបងដែលបានទាក់ទងមកកាន់ផេកយើងខ្ញុំ។ 🙏💙',
].join('\n');

/**
 * Resolve the effective default outreach message.
 * DB value (if a non-empty one is saved) → OUTREACH_STATIC_MESSAGE env →
 * DEFAULT_STATIC_MESSAGE. A DB read failure logs a warning and falls back so
 * generation never breaks.
 */
export async function getStaticOutreachMessage(): Promise<string> {
  try {
    const saved = await new OutreachSettingsRepository().getStaticMessage();
    if (saved && saved.trim()) return saved.trim();
  } catch (err) {
    Logger.warn(`getStaticOutreachMessage DB read failed, using fallback: ${(err as Error).message}`);
  }
  return process.env.OUTREACH_STATIC_MESSAGE?.trim() || DEFAULT_STATIC_MESSAGE;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: FAIL — `outreach-agent.ts` still awaits nothing / calls the now-async function synchronously. This confirms the only caller is the one Task 3 fixes. (If it unexpectedly PASSES, the caller was already await-compatible — proceed anyway.)

- [ ] **Step 3: Commit**

```bash
git add src/outreach/static-template.ts
git commit -m "Make getStaticOutreachMessage async: DB > env > constant

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Generator uses the async resolver

**Files:**
- Modify: `src/outreach/outreach-agent.ts` (around line 75–100)

**Interfaces:**
- Consumes: `getStaticOutreachMessage(): Promise<string>` from Task 2.
- Produces: nothing new; fixes the compile error from Task 2.

- [ ] **Step 1: Resolve the message once before the candidate loop**

In `src/outreach/outreach-agent.ts`, find this line (~75):

```typescript
  Logger.info(`outreach.generateBatch(${generationId}): ${candidates.length} candidates`);
```

Immediately after it (before the `for (const customer of candidates) {` loop), insert:

```typescript
  const staticMessage = await getStaticOutreachMessage();
```

- [ ] **Step 2: Use the resolved value in the proposal**

In the same file, find (~line 100):

```typescript
      message: getStaticOutreachMessage(),
```

Replace it with:

```typescript
      message: staticMessage,
```

- [ ] **Step 3: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS. The async call is now awaited outside the loop and the sync call site is gone.

- [ ] **Step 4: Commit**

```bash
git add src/outreach/outreach-agent.ts
git commit -m "Generator resolves default text via async resolver

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: API routes GET/POST/DELETE /default-text

**Files:**
- Modify: `src/api/outreach-routes.ts` (add import; add three routes near the default-video routes, before the `/:id/*` routes so `default-text` is never captured by `:id`)

**Interfaces:**
- Consumes: `OutreachSettingsRepository` (Task 1); `getStaticOutreachMessage`, `DEFAULT_STATIC_MESSAGE` (Task 2); existing `getSessionUser`, `Logger`, `express`.
- Produces: HTTP routes
  - `GET /crm/api/outreach/default-text` → `{ message, is_custom, updated_at, updated_by, default_message }`
  - `POST /crm/api/outreach/default-text` body `{ message }` → `{ ok: true }`
  - `DELETE /crm/api/outreach/default-text` → `{ ok: true }`

- [ ] **Step 1: Add imports**

At the top of `src/api/outreach-routes.ts`, alongside the other outreach imports (e.g. after the `OutreachVideoRepository` import on line 6), add:

```typescript
import { OutreachSettingsRepository } from '../outreach/outreach-settings-repository';
import { getStaticOutreachMessage, DEFAULT_STATIC_MESSAGE } from '../outreach/static-template';
```

- [ ] **Step 2: Add the three routes**

Insert the following block immediately BEFORE the `// POST /crm/api/outreach/:id/approve` route (currently line ~403). Placing it before any `/:id` route ensures `default-text` is matched as a literal path.

```typescript
// GET /crm/api/outreach/default-text — effective message + whether a custom one is saved
router.get('/default-text', async (_req: Request, res: Response) => {
  try {
    const repo = new OutreachSettingsRepository();
    const saved = await repo.getStaticMessage();
    let updated_at: Date | null = null;
    let updated_by: string | null = null;
    if (saved && saved.trim()) {
      const doc = await repo['col'].findOne({ _id: 'default' } as any);
      updated_at = doc?.updated_at ?? null;
      updated_by = doc?.updated_by ?? null;
    }
    const message = await getStaticOutreachMessage();
    res.json({
      message,
      is_custom: Boolean(saved && saved.trim()),
      updated_at,
      updated_by,
      default_message: DEFAULT_STATIC_MESSAGE,
    });
  } catch (err) {
    Logger.error('default-text GET failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/default-text — save the operator-edited default message
router.post('/default-text', express.json(), async (req: Request, res: Response) => {
  try {
    const raw = req.body?.message;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      res.status(400).json({ error: 'message required' });
      return;
    }
    const message = raw.trim();
    if (message.length > 4096) {
      res.status(400).json({ error: 'message exceeds 4096 characters' });
      return;
    }
    const updatedBy = getSessionUser(req) || 'unknown';
    await new OutreachSettingsRepository().setStaticMessage(message, updatedBy);
    Logger.info(`outreach default text updated by ${updatedBy} (${message.length} chars)`);
    res.json({ ok: true });
  } catch (err) {
    Logger.error('default-text POST failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /crm/api/outreach/default-text — clear the saved message, revert to env/hardcoded
router.delete('/default-text', async (req: Request, res: Response) => {
  try {
    await new OutreachSettingsRepository().clearStaticMessage();
    Logger.info(`outreach default text reset to default by ${getSessionUser(req) || 'unknown'}`);
    res.json({ ok: true });
  } catch (err) {
    Logger.error('default-text DELETE failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

Note on the `repo['col']` access in the GET route: `OutreachSettingsRepository` exposes only `getStaticMessage()`, which returns the string but not `updated_at`/`updated_by`. Rather than reach into the private `col`, add a small public method instead — see Step 3.

- [ ] **Step 3: Add a `getDefaultDoc()` method instead of private access**

In `src/outreach/outreach-settings-repository.ts` (Task 1 file), add this method to the class (below `getStaticMessage`):

```typescript
  /** Full settings doc, or null. Used by the API to surface updated_at/by. */
  async getDefaultDoc(): Promise<OutreachSettingsDocument | null> {
    return this.col.findOne({ _id: DEFAULT_ID } as any);
  }
```

Then in the GET route from Step 2, replace the `repo['col'].findOne(...)` block with:

```typescript
      const doc = await repo.getDefaultDoc();
      updated_at = doc?.updated_at ?? null;
      updated_by = doc?.updated_by ?? null;
```

- [ ] **Step 4: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/outreach-routes.ts src/outreach/outreach-settings-repository.ts
git commit -m "API: GET/POST/DELETE /default-text for the default outreach message

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Default-text card in outreach.hbs

**Files:**
- Modify: `src/reports/templates/crm/outreach.hbs` (add a card after the default-video card ~line 319; add JS after `uploadDefaultVideo`/`removeDefaultVideo` ~line 469; call `refreshDefaultText()` in the init block ~line 842)

**Interfaces:**
- Consumes: the Task 4 routes; existing `showToast()`, `counterClass()`, and the `.default-image-card` styles.
- Produces: UI only.

- [ ] **Step 1: Add the card markup**

In `src/reports/templates/crm/outreach.hbs`, immediately after the default-video card's closing `</div>` (the `<div class="default-image-card" id="default-video-card">…</div>` block, ~line 319) and before `<div class="lightbox-backdrop" …>`, insert:

```html
  <div class="default-image-card" id="default-text-card" style="align-items:flex-start">
    <div class="default-image-meta" style="flex:1 1 100%">
      <div class="name" id="default-text-name">Default message text</div>
      <div class="sub" id="default-text-sub">Applies to newly generated proposals.</div>
      <textarea id="default-text-input" class="proposal-message" style="margin-top:0.5rem;min-height:120px" placeholder="Loading…"></textarea>
      <div class="image-bar" style="margin-top:0.4rem">
        <span class="label" id="default-text-source">—</span>
        <span class="counter" id="default-text-counter">0 / 1024</span>
        <div class="actions" style="margin-left:auto">
          <button class="btn btn-ghost" id="default-text-reset" onclick="resetDefaultText()">Reset to default</button>
          <button class="btn btn-primary" id="default-text-save" onclick="saveDefaultText()">Save</button>
        </div>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Add the JS handlers**

In the same file, after the `removeDefaultVideo()` function (~line 469), insert:

```javascript
  const DEFAULT_TEXT_URL = API + '/default-text';
  let defaultTextFallback = '';

  function updateDefaultTextCounter() {
    const ta = document.getElementById('default-text-input');
    const counter = document.getElementById('default-text-counter');
    const saveBtn = document.getElementById('default-text-save');
    if (!ta || !counter) return;
    const len = ta.value.length;
    counter.textContent = len + ' / 1024';
    counter.classList.remove('green', 'yellow', 'red');
    counter.classList.add(counterClass(len));
    if (saveBtn) saveBtn.disabled = len === 0 || ta.value.trim().length === 0 || len > 4096;
  }

  async function refreshDefaultText() {
    const ta = document.getElementById('default-text-input');
    const source = document.getElementById('default-text-source');
    try {
      const resp = await fetch(DEFAULT_TEXT_URL + '?cb=' + Date.now(), { credentials: 'same-origin' });
      if (!resp.ok) throw new Error('GET default-text ' + resp.status);
      const data = await resp.json();
      defaultTextFallback = data.default_message || '';
      ta.value = data.message || '';
      if (data.is_custom) {
        source.textContent = 'Custom (edited' + (data.updated_by ? ' by ' + data.updated_by : '') + ')';
        source.classList.add('custom');
      } else {
        source.textContent = 'Using built-in default';
        source.classList.remove('custom');
      }
      updateDefaultTextCounter();
    } catch (err) {
      console.error('refreshDefaultText', err);
    }
  }

  async function saveDefaultText() {
    const msg = document.getElementById('default-text-input').value;
    if (!msg.trim()) { showToast('Message cannot be empty', 'error'); return; }
    try {
      const resp = await fetch(DEFAULT_TEXT_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) { showToast('Default text saved', 'success'); refreshDefaultText(); }
      else showToast(data.error || ('Save failed: ' + resp.status), 'error');
    } catch { showToast('Save failed', 'error'); }
  }

  async function resetDefaultText() {
    if (!confirm('Reset the default message to the built-in text?')) return;
    try {
      const resp = await fetch(DEFAULT_TEXT_URL, { method: 'DELETE', credentials: 'same-origin' });
      if (resp.ok) { showToast('Reset to default', 'success'); refreshDefaultText(); }
      else showToast('Reset failed', 'error');
    } catch { showToast('Reset failed', 'error'); }
  }
```

- [ ] **Step 3: Wire the counter listener and init call**

In the same file, find the init block near the end (~line 842):

```javascript
  refreshDefaultImage();
  refreshDefaultVideo();
  startWorkerStatusPoll();
  loadList();
```

Replace it with:

```javascript
  document.getElementById('default-text-input').addEventListener('input', updateDefaultTextCounter);
  refreshDefaultImage();
  refreshDefaultVideo();
  refreshDefaultText();
  startWorkerStatusPoll();
  loadList();
```

- [ ] **Step 4: Verify it typechecks (build not affected by hbs, but confirm nothing else broke)**

Run: `npm run typecheck`
Expected: PASS (hbs is not compiled by tsc; this just confirms Tasks 1–4 still build).

- [ ] **Step 5: Commit**

```bash
git add src/reports/templates/crm/outreach.hbs
git commit -m "CRM: default-text card (edit / save / reset) on the Outreach page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Manual end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Start the app**

Run: `npm run dev` (or the project's usual start). Log in and open `/crm/outreach`.

- [ ] **Step 2: Verify read**

The new "Default message text" card shows the current Khmer message and "Using built-in default". Counter reflects length.

- [ ] **Step 3: Verify update**

Edit the textarea, click **Save**. Toast "Default text saved"; card now shows "Custom (edited by <you>)". Reload the page — the edited text persists.

- [ ] **Step 4: Verify it flows into generation**

Click **Generate batch** (or "Test on me"). Open a newly created pending proposal — its message equals the edited default text. Confirm a pre-existing pending proposal (from before the edit) is unchanged.

- [ ] **Step 5: Verify validation + reset**

Clear the textarea → **Save** is disabled / empty is rejected with a 400 toast. Click **Reset to default** → confirm dialog → card reverts to "Using built-in default" and the original Khmer text. A subsequent Generate uses the built-in text.

- [ ] **Step 6: Final commit (if any doc updates needed)**

No code change expected here. If `OUTREACH_MEDIA.md` documents the media defaults, add a line noting the default text is now editable at `/crm/outreach`, then commit.

---

## Self-Review

**Spec coverage:**
- New repository → Task 1. ✅
- Async resolver w/ DB > env > constant precedence → Task 2. ✅
- Generator uses resolver, resolved once before loop → Task 3. ✅
- GET/POST/DELETE routes w/ validation (empty→400, >4096→400), auth via router-wide `authMiddleware` → Task 4. ✅
- UI card (textarea, counter, Save, Reset, "applies to new proposals" note) → Task 5. ✅
- Error handling: DB-read fallback in resolver (Task 2), 400s in POST (Task 4), toast on client (Task 5). ✅
- Effect-timing (only new proposals) verified → Task 6 Step 4. ✅

**Placeholder scan:** No TBD/TODO; all code shown in full. The `repo['col']` private-access shortcut in Task 4 Step 2 is explicitly replaced by a real `getDefaultDoc()` method in Task 4 Step 3. ✅

**Type consistency:** `getStaticMessage`/`setStaticMessage`/`clearStaticMessage`/`getDefaultDoc` names match across Tasks 1 and 4. `getStaticOutreachMessage(): Promise<string>` and exported `DEFAULT_STATIC_MESSAGE` match across Tasks 2, 3, 4. Route paths (`/default-text`) match across Tasks 4 and 5. ✅
