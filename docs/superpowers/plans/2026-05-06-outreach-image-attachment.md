# Outreach Image Attachment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach a default brand image (with optional per-proposal custom override) to every outbound outreach message, sent via the existing MTProto worker as image+caption (or image then text when over Telegram's 1024-char caption cap).

**Architecture:** New `outreach_images` MongoDB collection with one fixed `_id: 'default'` doc and per-proposal customs keyed by `ObjectId`. The proposal document gains a `custom_image_id: ObjectId | null` field. Server-side endpoints handle multipart uploads (multer memoryStorage, 5MB cap, JPEG/PNG/WebP only) and a worker-only `effective-image` endpoint that resolves custom-vs-default at send time. Worker fetches the image via HTTP after claim, smart-splits between caption mode (≤1024 chars) and two-bubble mode using `client.sendFile` from gramjs.

**Tech Stack:** TypeScript, Express, MongoDB driver 6.3, multer 2.1, gramjs (`telegram` 2.26), Handlebars templates, existing dark-theme dashboard.

**Spec:** [`docs/superpowers/specs/2026-05-06-outreach-image-attachment-design.md`](../specs/2026-05-06-outreach-image-attachment-design.md)

---

## File Map

**Create:**
- `src/outreach/outreach-images-repository.ts` — CRUD for `outreach_images` collection

**Modify:**
- `src/outreach/outreach-repository.ts` — add `custom_image_id` field to `OutreachProposalDocument` and helpers to set/clear it
- `src/api/outreach-routes.ts` — add five endpoints; gate `/generate` on default image existing
- `src/api/auth-middleware.ts` — add `effective-image` to the agent allowlist
- `src/reports/templates/crm/outreach.hbs` — default-image card, per-proposal editing bar, counter logic, generate-button gating
- `scripts/telegram-worker/worker.ts` — fetch image after claim, smart-split send via `client.sendFile`

**No tests folder exists in this repo.** Verification is HTTP commands (PowerShell `Invoke-RestMethod` / `curl`) for server tasks and browser smoke tests for UI tasks. Each task has a "verify before / implement / verify after" cadence so regressions are caught at the task level.

---

## Working notes for the engineer

- The dev server runs via `npm run dev` (ts-node). Production build is `npm run build && npm start`. Type-check only with `npm run typecheck`.
- The dashboard auth is cookie-based via `DASHBOARD_TOKEN`. For PowerShell verification, log in via the browser first to get the cookie, then either copy the cookie into curl, or use the bearer token form: `Authorization: Bearer <DASHBOARD_TOKEN>` — that's accepted as the `developer` role on every endpoint.
- The worker uses `Authorization: Bearer <AGENT_TOKEN>`. The agent role is restricted to a path allowlist in `auth-middleware.ts:165` — Task 5 must add the new `effective-image` path to that list, otherwise the worker will get 403.
- The `outreach.hbs` template is rendered by the existing route in `src/api/crm-routes.ts` (or wherever `outreach.hbs` is mounted — check `Grep` for `outreach.hbs` if uncertain).
- All commits use the existing footer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Use `git add <specific files>` — never `git add -A`.

---

## Task 1: Create `OutreachImagesRepository`

**Files:**
- Create: `src/outreach/outreach-images-repository.ts`

- [ ] **Step 1: Write the verification command first**

The repository should be loadable and instantiable. Verification:

```powershell
# This will fail at first because the file doesn't exist
npx ts-node -e "const { OutreachImagesRepository } = require('./src/outreach/outreach-images-repository'); console.log(typeof OutreachImagesRepository);"
```
Expected before implementation: `Cannot find module './src/outreach/outreach-images-repository'`.

- [ ] **Step 2: Confirm it fails**

Run the command above. Expected output contains `Cannot find module`.

- [ ] **Step 3: Create the repository file**

```ts
// src/outreach/outreach-images-repository.ts
import { Collection, ObjectId, Binary } from 'mongodb';
import DatabaseConnection from '../database/connection';
import { Logger } from '../utils/logger';

export type ImageKind = 'default' | 'proposal_custom';

export interface OutreachImageDocument {
  _id: ObjectId | 'default';
  filename: string;
  mime_type: string;
  size_bytes: number;
  data: Binary;
  uploaded_at: Date;
  uploaded_by: string;
  kind: ImageKind;
}

const COLLECTION = 'outreach_images';
const DEFAULT_ID = 'default';

let indexesReady = false;

export class OutreachImagesRepository {
  private col: Collection<OutreachImageDocument>;

  constructor() {
    const db = DatabaseConnection.getInstance().getDb();
    this.col = db.collection<OutreachImageDocument>(COLLECTION);
    if (!indexesReady) {
      indexesReady = true;
      this.col
        .createIndexes([{ key: { kind: 1 }, name: 'kind_idx' }])
        .catch((err) => Logger.error('outreach_images index creation failed', err as Error));
    }
  }

  async getDefault(): Promise<OutreachImageDocument | null> {
    return this.col.findOne({ _id: DEFAULT_ID } as any);
  }

  async hasDefault(): Promise<boolean> {
    return (await this.col.countDocuments({ _id: DEFAULT_ID } as any)) > 0;
  }

  async setDefault(input: {
    filename: string;
    mime_type: string;
    buffer: Buffer;
    uploaded_by: string;
  }): Promise<void> {
    const doc: OutreachImageDocument = {
      _id: DEFAULT_ID,
      filename: input.filename,
      mime_type: input.mime_type,
      size_bytes: input.buffer.length,
      data: new Binary(input.buffer),
      uploaded_at: new Date(),
      uploaded_by: input.uploaded_by,
      kind: 'default',
    };
    await this.col.replaceOne({ _id: DEFAULT_ID } as any, doc, { upsert: true });
  }

  async getById(id: string | ObjectId): Promise<OutreachImageDocument | null> {
    try {
      const oid = typeof id === 'string' ? new ObjectId(id) : id;
      return await this.col.findOne({ _id: oid } as any);
    } catch {
      return null;
    }
  }

  async insertCustom(input: {
    filename: string;
    mime_type: string;
    buffer: Buffer;
    uploaded_by: string;
  }): Promise<ObjectId> {
    const oid = new ObjectId();
    const doc: OutreachImageDocument = {
      _id: oid,
      filename: input.filename,
      mime_type: input.mime_type,
      size_bytes: input.buffer.length,
      data: new Binary(input.buffer),
      uploaded_at: new Date(),
      uploaded_by: input.uploaded_by,
      kind: 'proposal_custom',
    };
    await this.col.insertOne(doc as any);
    return oid;
  }

  async deleteCustom(id: string | ObjectId): Promise<boolean> {
    try {
      const oid = typeof id === 'string' ? new ObjectId(id) : id;
      const result = await this.col.deleteOne({ _id: oid, kind: 'proposal_custom' } as any);
      return result.deletedCount === 1;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 4: Verify the file loads**

```powershell
npx ts-node -e "const { OutreachImagesRepository } = require('./src/outreach/outreach-images-repository'); console.log(typeof OutreachImagesRepository);"
```
Expected: `function`.

- [ ] **Step 5: Type-check**

```powershell
npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```powershell
git add src/outreach/outreach-images-repository.ts
git commit -m "Add OutreachImagesRepository for default and per-proposal custom images

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `custom_image_id` to `OutreachProposalDocument`

**Files:**
- Modify: `src/outreach/outreach-repository.ts`

- [ ] **Step 1: Verify the field doesn't exist yet**

```powershell
Select-String -Path src\outreach\outreach-repository.ts -Pattern "custom_image_id"
```
Expected: no matches.

- [ ] **Step 2: Add the field to the interface**

In `src/outreach/outreach-repository.ts`, modify the `OutreachProposalDocument` interface (around line 7–27). Add this field directly after `failed_reason`:

```ts
  custom_image_id: ObjectId | null;
```

The full interface should now read:

```ts
export interface OutreachProposalDocument {
  _id?: ObjectId;
  generation_id: string;
  customer_phone: string;
  customer_name: string | null;
  reason_code: string | null;
  days_since_contact: number | null;
  follower: string | null;
  message: string;
  reasoning: string;
  status: OutreachStatus;
  skipped_reason: string | null;
  failed_reason: string | null;
  custom_image_id: ObjectId | null;
  created_at: Date;
  approved_at: Date | null;
  approved_by: string | null;
  sent_at: Date | null;
  lease_expires_at: Date | null;
  claim_attempts?: number;
  model: string;
}
```

- [ ] **Step 3: Add setter and clearer methods**

In `src/outreach/outreach-repository.ts`, append two new methods to the `OutreachRepository` class (just before the closing brace). They are tolerant of pending OR approved status — the user can edit the image up until the worker claims:

```ts
  async setCustomImage(id: string, imageId: ObjectId): Promise<boolean> {
    try {
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), status: { $in: ['pending', 'approved'] } },
        { $set: { custom_image_id: imageId } }
      );
      return result.matchedCount > 0;
    } catch {
      return false;
    }
  }

  async clearCustomImage(id: string): Promise<{ ok: boolean; previous: ObjectId | null }> {
    try {
      const existing = await this.col.findOne({ _id: new ObjectId(id) });
      if (!existing) return { ok: false, previous: null };
      const previous = existing.custom_image_id ?? null;
      const result = await this.col.updateOne(
        { _id: new ObjectId(id), status: { $in: ['pending', 'approved'] } },
        { $set: { custom_image_id: null } }
      );
      return { ok: result.matchedCount > 0, previous };
    } catch {
      return { ok: false, previous: null };
    }
  }
```

- [ ] **Step 4: Backfill existing inserts to include `custom_image_id: null`**

In the same file, look at `insertMany` callers in `src/outreach/outreach-agent.ts`. The existing `toInsert` objects don't set `custom_image_id`. Update `src/outreach/outreach-agent.ts` so all three `toInsert.push({ ... })` blocks include `custom_image_id: null` to satisfy the now-required field.

For each of the three blocks (lines roughly 89, 117, 142 — search for `toInsert.push({`), add this line in each (placement: directly after `failed_reason: null,`):

```ts
        custom_image_id: null,
```

- [ ] **Step 5: Type-check**

```powershell
npm run typecheck
```
Expected: no errors. If errors mention missing `custom_image_id`, you missed a `toInsert.push` block — search for `toInsert.push({` and ensure all three have the field.

- [ ] **Step 6: Commit**

```powershell
git add src/outreach/outreach-repository.ts src/outreach/outreach-agent.ts
git commit -m "Add custom_image_id field to outreach proposals

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Default-image API endpoints (GET + POST)

**Files:**
- Modify: `src/api/outreach-routes.ts`

- [ ] **Step 1: Verify endpoints don't exist yet**

```powershell
Select-String -Path src\api\outreach-routes.ts -Pattern "default-image"
```
Expected: no matches.

- [ ] **Step 2: Add multer import and instance**

At the top of `src/api/outreach-routes.ts`, add the multer import below the existing imports:

```ts
import multer from 'multer';
```

Below the existing constants near the top of the file (after `const DEFAULT_DAILY_CAP = 15;`), add:

```ts
const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } });
```

- [ ] **Step 3: Add the OutreachImagesRepository import**

At the top of `src/api/outreach-routes.ts`, after the existing `OutreachRepository` import:

```ts
import { OutreachImagesRepository } from '../outreach/outreach-images-repository';
```

- [ ] **Step 4: Add GET and POST endpoints for default image**

Insert these route handlers above the `// POST /crm/api/outreach/:id/approve` line (so they don't get caught by the `:id` matcher). Both endpoints return JSON for errors and binary for the image GET:

```ts
// GET /crm/api/outreach/default-image  — returns binary
router.get('/default-image', async (_req: Request, res: Response) => {
  try {
    const repo = new OutreachImagesRepository();
    const doc = await repo.getDefault();
    if (!doc) {
      res.status(404).json({ error: 'No default image set' });
      return;
    }
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('X-Filename', encodeURIComponent(doc.filename));
    res.setHeader('Content-Length', String(doc.size_bytes));
    res.send(doc.data.buffer);
  } catch (err) {
    Logger.error('default-image GET failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/default-image  — multipart upload, replaces default
router.post('/default-image', imageUpload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded (field name: file)' }); return; }
    if (!ALLOWED_IMAGE_MIME.includes(req.file.mimetype)) {
      res.status(400).json({ error: `Mime ${req.file.mimetype} not allowed; use JPEG, PNG, or WebP` });
      return;
    }
    const uploadedBy = getSessionUser(req) || 'unknown';
    await new OutreachImagesRepository().setDefault({
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      buffer: req.file.buffer,
      uploaded_by: uploadedBy,
    });
    Logger.info(`outreach default image replaced by ${uploadedBy}: ${req.file.originalname} (${req.file.size}B, ${req.file.mimetype})`);
    res.json({ ok: true, filename: req.file.originalname, size_bytes: req.file.size, mime_type: req.file.mimetype });
  } catch (err) {
    Logger.error('default-image POST failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 5: Type-check**

```powershell
npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Verify GET returns 404 when no default exists**

Start the dev server in another terminal: `npm run dev`. Then:

```powershell
$headers = @{ Authorization = "Bearer $env:DASHBOARD_TOKEN" }
Invoke-WebRequest -Uri "http://localhost:3000/crm/api/outreach/default-image" -Headers $headers -ErrorAction SilentlyContinue
```
Expected: HTTP 404, body `{"error":"No default image set"}`. (Substitute the correct port if not 3000 — check `src/api/server.ts` or `.env` for `PORT`.)

- [ ] **Step 7: Verify POST accepts a small JPEG and stores it**

Use the sample brand image you'd actually upload. From PowerShell:

```powershell
$headers = @{ Authorization = "Bearer $env:DASHBOARD_TOKEN" }
$form = @{ file = Get-Item ".\brain-empty.png" }  # any small image you have
Invoke-RestMethod -Uri "http://localhost:3000/crm/api/outreach/default-image" -Method Post -Headers $headers -Form $form
```
Expected: `{ ok: true, filename: "brain-empty.png", size_bytes: <n>, mime_type: "image/png" }`.

Then re-run the GET from Step 6 — expected: HTTP 200, body is the raw image bytes, `Content-Type: image/png` header set.

- [ ] **Step 8: Verify oversized upload is rejected**

```powershell
# Generate a 6MB dummy file
$bytes = New-Object byte[] (6 * 1024 * 1024); [System.IO.File]::WriteAllBytes(".\too-big.bin", $bytes)
$form = @{ file = Get-Item ".\too-big.bin" }
Invoke-RestMethod -Uri "http://localhost:3000/crm/api/outreach/default-image" -Method Post -Headers $headers -Form $form
Remove-Item ".\too-big.bin"
```
Expected: HTTP 413 from multer's built-in limit (or a 500 with "File too large" — multer's default error handling is loose; either is acceptable).

- [ ] **Step 9: Verify wrong mime is rejected**

```powershell
"not an image" | Out-File -Encoding ascii ".\fake.txt"
$form = @{ file = Get-Item ".\fake.txt" }
Invoke-RestMethod -Uri "http://localhost:3000/crm/api/outreach/default-image" -Method Post -Headers $headers -Form $form
Remove-Item ".\fake.txt"
```
Expected: HTTP 400, body contains `Mime text/plain not allowed`.

- [ ] **Step 10: Commit**

```powershell
git add src/api/outreach-routes.ts
git commit -m "Default-image GET and POST endpoints with multer upload

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Per-proposal custom-image endpoints (POST + DELETE)

**Files:**
- Modify: `src/api/outreach-routes.ts`

- [ ] **Step 1: Verify endpoints don't exist yet**

```powershell
Select-String -Path src\api\outreach-routes.ts -Pattern "/:id/image"
```
Expected: no matches.

- [ ] **Step 2: Add the two endpoints**

Insert these handlers near the other `:id`-prefixed routes (e.g. between `/:id/skip` and `/:id/approve` or at the end of those, before the worker-only routes):

```ts
// POST /crm/api/outreach/:id/image  — multipart upload; sets custom_image_id
router.post('/:id/image', imageUpload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded (field name: file)' }); return; }
    if (!ALLOWED_IMAGE_MIME.includes(req.file.mimetype)) {
      res.status(400).json({ error: `Mime ${req.file.mimetype} not allowed; use JPEG, PNG, or WebP` });
      return;
    }

    const proposalRepo = new OutreachRepository();
    const proposal = await proposalRepo.getById(req.params.id);
    if (!proposal) { res.status(404).json({ error: 'proposal not found' }); return; }
    if (proposal.status !== 'pending' && proposal.status !== 'approved') {
      res.status(409).json({ error: `cannot edit image when status is ${proposal.status}` });
      return;
    }

    const imagesRepo = new OutreachImagesRepository();
    const uploadedBy = getSessionUser(req) || 'unknown';

    // Insert the new custom image first, then attach it. If a previous custom
    // existed, delete it after the swap to avoid orphaning the in-use image.
    const newId = await imagesRepo.insertCustom({
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      buffer: req.file.buffer,
      uploaded_by: uploadedBy,
    });
    const previousId = proposal.custom_image_id;
    const setOk = await proposalRepo.setCustomImage(req.params.id, newId);
    if (!setOk) {
      // race: status flipped between getById and setCustomImage; clean up
      await imagesRepo.deleteCustom(newId);
      res.status(409).json({ error: 'proposal status changed during upload' });
      return;
    }
    if (previousId) {
      await imagesRepo.deleteCustom(previousId);
    }

    Logger.info(`outreach custom image set on proposal=${req.params.id} by ${uploadedBy}: ${req.file.originalname} (${req.file.size}B, ${req.file.mimetype})`);
    res.json({ ok: true, image_id: newId.toString(), filename: req.file.originalname, size_bytes: req.file.size, mime_type: req.file.mimetype });
  } catch (err) {
    Logger.error('proposal image POST failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /crm/api/outreach/:id/image  — removes custom, reverts to default
router.delete('/:id/image', async (req: Request, res: Response) => {
  try {
    const proposalRepo = new OutreachRepository();
    const proposal = await proposalRepo.getById(req.params.id);
    if (!proposal) { res.status(404).json({ error: 'proposal not found' }); return; }
    if (proposal.status !== 'pending' && proposal.status !== 'approved') {
      res.status(409).json({ error: `cannot edit image when status is ${proposal.status}` });
      return;
    }

    const { ok, previous } = await proposalRepo.clearCustomImage(req.params.id);
    if (!ok) { res.status(409).json({ error: 'could not clear (status changed)' }); return; }
    if (previous) {
      await new OutreachImagesRepository().deleteCustom(previous);
    }

    Logger.info(`outreach custom image cleared on proposal=${req.params.id} by ${getSessionUser(req) || 'unknown'} (prev=${previous?.toString() || 'none'})`);
    res.json({ ok: true });
  } catch (err) {
    Logger.error('proposal image DELETE failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 3: Type-check**

```powershell
npm run typecheck
```
Expected: no errors.

- [ ] **Step 4: Verify POST attaches a custom image to a real pending proposal**

Generate a batch first if you don't have one (use the existing `/generate` endpoint via the dashboard or curl). Then grab a pending proposal id from `GET /crm/api/outreach?status=pending`. Set `$pid` to that id:

```powershell
$headers = @{ Authorization = "Bearer $env:DASHBOARD_TOKEN" }
$form = @{ file = Get-Item ".\brain-empty.png" }
Invoke-RestMethod -Uri "http://localhost:3000/crm/api/outreach/$pid/image" -Method Post -Headers $headers -Form $form
```
Expected: `{ ok: true, image_id: "<24-hex>", ... }`.

Then verify `custom_image_id` was set on the proposal:

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/crm/api/outreach?status=pending" -Headers $headers | ConvertTo-Json -Depth 5 | Select-String "custom_image_id"
```
Expected: at least one line shows `"custom_image_id": "<24-hex>"`.

- [ ] **Step 5: Verify DELETE clears it**

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/crm/api/outreach/$pid/image" -Method Delete -Headers $headers
```
Expected: `{ ok: true }`. Re-run the GET from Step 4 — `custom_image_id` should be `null`.

- [ ] **Step 6: Commit**

```powershell
git add src/api/outreach-routes.ts
git commit -m "Per-proposal custom image POST and DELETE endpoints

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `effective-image` endpoint (worker)

**Files:**
- Modify: `src/api/outreach-routes.ts`
- Modify: `src/api/auth-middleware.ts`

- [ ] **Step 1: Verify the endpoint doesn't exist**

```powershell
Select-String -Path src\api\outreach-routes.ts -Pattern "effective-image"
```
Expected: no matches.

- [ ] **Step 2: Add the route handler**

Insert this near the other worker-only routes (after `mark-failed`, before `export default router`):

```ts
// GET /crm/api/outreach/:id/effective-image  — worker-only
// Returns the bytes the worker should send: custom if custom_image_id set, else default.
router.get('/:id/effective-image', async (req: Request, res: Response) => {
  try {
    const proposalRepo = new OutreachRepository();
    const proposal = await proposalRepo.getById(req.params.id);
    if (!proposal) { res.status(404).json({ error: 'proposal not found' }); return; }

    const imagesRepo = new OutreachImagesRepository();
    let doc;
    let resolvedKind: 'default' | 'proposal_custom';
    if (proposal.custom_image_id) {
      doc = await imagesRepo.getById(proposal.custom_image_id);
      resolvedKind = 'proposal_custom';
      if (!doc) {
        // Custom is referenced but missing — fall back to default and log loudly.
        Logger.warn(`effective-image: custom_image_id ${proposal.custom_image_id} missing for proposal ${req.params.id}, falling back to default`);
        doc = await imagesRepo.getDefault();
        resolvedKind = 'default';
      }
    } else {
      doc = await imagesRepo.getDefault();
      resolvedKind = 'default';
    }

    if (!doc) {
      Logger.error(`effective-image: no image available for proposal ${req.params.id} (no custom, no default)`);
      res.status(404).json({ error: 'no default image and no custom set' });
      return;
    }

    Logger.info(`effective-image[${req.params.id}] resolved=${resolvedKind} filename=${doc.filename} size=${doc.size_bytes}`);
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('X-Filename', encodeURIComponent(doc.filename));
    res.setHeader('X-Image-Kind', resolvedKind);
    res.setHeader('Content-Length', String(doc.size_bytes));
    res.send(doc.data.buffer);
  } catch (err) {
    Logger.error('effective-image GET failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 3: Add the path to the agent allowlist**

In `src/api/auth-middleware.ts`, find `AGENT_ALLOWED` (around line 165). Add this entry to the array (after the existing `worker-status` entry, before the closing `]`):

```ts
  { method: 'GET',  pattern: /^\/crm\/api\/outreach\/[A-Za-z0-9_-]+\/effective-image$/ },
```

- [ ] **Step 4: Type-check**

```powershell
npm run typecheck
```
Expected: no errors.

- [ ] **Step 5: Verify with developer bearer (any logged-in user can hit it)**

```powershell
$headers = @{ Authorization = "Bearer $env:DASHBOARD_TOKEN" }
Invoke-WebRequest -Uri "http://localhost:3000/crm/api/outreach/$pid/effective-image" -Headers $headers -OutFile ".\fetched.bin"
Get-Item ".\fetched.bin" | Select-Object Length
Remove-Item ".\fetched.bin"
```
Expected: a non-zero file is written; `Length` is the same as the size of the default image you uploaded in Task 3.

- [ ] **Step 6: Verify with agent token (worker-style call)**

```powershell
$headers = @{ Authorization = "Bearer $env:AGENT_TOKEN" }
Invoke-WebRequest -Uri "http://localhost:3000/crm/api/outreach/$pid/effective-image" -Headers $headers -OutFile ".\fetched.bin" | Select-Object StatusCode
Remove-Item ".\fetched.bin"
```
Expected: 200. If you see 403, the allowlist regex is wrong — re-check Step 3.

- [ ] **Step 7: Verify the kind header switches when a custom is attached**

Re-attach a custom (Task 4 Step 4), then:

```powershell
$headers = @{ Authorization = "Bearer $env:AGENT_TOKEN" }
(Invoke-WebRequest -Uri "http://localhost:3000/crm/api/outreach/$pid/effective-image" -Headers $headers).Headers["X-Image-Kind"]
```
Expected: `proposal_custom`. After DELETE: `default`.

- [ ] **Step 8: Commit**

```powershell
git add src/api/outreach-routes.ts src/api/auth-middleware.ts
git commit -m "Worker-only effective-image endpoint with agent allowlist

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Gate `/generate` on default image existing

**Files:**
- Modify: `src/api/outreach-routes.ts`

- [ ] **Step 1: Verify current behavior**

With no default image (delete it first via the DB if you have to, or just rename the doc), call:

```powershell
$headers = @{ Authorization = "Bearer $env:DASHBOARD_TOKEN" }
Invoke-RestMethod -Uri "http://localhost:3000/crm/api/outreach/generate" -Method Post -Headers $headers -ContentType "application/json" -Body '{"limit":1}'
```
Expected: succeeds, creates a proposal — but that proposal can never be sent. We're about to fix that.

- [ ] **Step 2: Add the gate**

In `src/api/outreach-routes.ts`, find the `// POST /crm/api/outreach/generate` handler. Insert a check at the top of the try block (before reading `req.body`):

```ts
    const hasDefault = await new OutreachImagesRepository().hasDefault();
    if (!hasDefault) {
      res.status(409).json({ error: 'No default brand image is set. Upload one before generating proposals.' });
      return;
    }
```

The full updated handler:

```ts
router.post('/generate', express.json(), async (req: Request, res: Response) => {
  try {
    const hasDefault = await new OutreachImagesRepository().hasDefault();
    if (!hasDefault) {
      res.status(409).json({ error: 'No default brand image is set. Upload one before generating proposals.' });
      return;
    }
    const { limit, followerFilter, phones, staleDays } = req.body || {};
    const opts: Parameters<typeof generateBatch>[0] = {};
    if (typeof limit === 'number') opts.limit = limit;
    if (typeof followerFilter === 'string') opts.followerFilter = followerFilter;
    if (Array.isArray(phones)) opts.phones = phones.filter((p): p is string => typeof p === 'string');
    if (typeof staleDays === 'number') opts.staleDays = staleDays;
    const result = await generateBatch(opts);
    res.json(result);
  } catch (err) {
    Logger.error('outreach/generate failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 3: Verify gate fires when no default**

Delete the default doc directly (e.g., via Mongo shell: `db.outreach_images.deleteOne({ _id: 'default' })`). Then:

```powershell
$headers = @{ Authorization = "Bearer $env:DASHBOARD_TOKEN" }
Invoke-RestMethod -Uri "http://localhost:3000/crm/api/outreach/generate" -Method Post -Headers $headers -ContentType "application/json" -Body '{"limit":1}'
```
Expected: HTTP 409, body `{"error":"No default brand image is set. Upload one before generating proposals."}`.

- [ ] **Step 4: Verify gate passes after upload**

Re-upload via the POST `/default-image` endpoint, then re-run the generate call. Expected: succeeds normally.

- [ ] **Step 5: Commit**

```powershell
git add src/api/outreach-routes.ts
git commit -m "Gate /generate on default brand image existing

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Worker — fetch image and smart-split send

**Files:**
- Modify: `scripts/telegram-worker/worker.ts`

- [ ] **Step 1: Verify current send path is text-only**

```powershell
Select-String -Path scripts\telegram-worker\worker.ts -Pattern "sendFile|effective-image"
```
Expected: no matches.

- [ ] **Step 2: Add the URL constant and image fetcher**

Near the top of `scripts/telegram-worker/worker.ts`, in the URL constants block (around line 36–43), add:

```ts
const EFFECTIVE_IMAGE_URL = (id: string) => `${BASE_URL}/crm/api/outreach/${id}/effective-image`;
```

Add this helper function just below the existing `markFailed` function:

```ts
async function fetchEffectiveImage(proposalId: string): Promise<{ buffer: Buffer; filename: string; kind: string } | null> {
  try {
    const resp = await authedFetch(EFFECTIVE_IMAGE_URL(proposalId));
    if (!resp.ok) {
      console.error(`effective-image ${resp.status}: ${await resp.text().catch(() => '')}`);
      return null;
    }
    const arr = await resp.arrayBuffer();
    const buffer = Buffer.from(arr);
    const rawFilename = resp.headers.get('x-filename') || 'brand.jpg';
    const filename = (() => { try { return decodeURIComponent(rawFilename); } catch { return rawFilename; } })();
    const kind = resp.headers.get('x-image-kind') || 'unknown';
    return { buffer, filename, kind };
  } catch (err) {
    console.error('effective-image fetch err', err);
    return null;
  }
}
```

- [ ] **Step 3: Import `CustomFile` from gramjs**

Update the imports at the top of `scripts/telegram-worker/worker.ts`. Find:

```ts
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
```

Add this line right after the others:

```ts
import { CustomFile } from 'telegram/client/uploads';
```

- [ ] **Step 4: Replace `sendViaMTProto` with the image-aware version**

Find the existing `sendViaMTProto` function (around line 216–240). Replace it entirely with:

```ts
async function sendViaMTProto(
  client: TelegramClient,
  proposalId: string,
  phone: string,
  message: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const phoneDigits = phone.replace(/\D/g, '');

  // Fetch the image first; mandatory per spec.
  const img = await fetchEffectiveImage(proposalId);
  if (!img) {
    return { ok: false, reason: 'image fetch failed (no default or worker auth issue)' };
  }
  console.log(`  image: ${img.kind} ${img.filename} ${img.buffer.length}B`);

  try {
    const peer = await client.getEntity(`+${phoneDigits}`);
    const file = new CustomFile(img.filename, img.buffer.length, '', img.buffer);

    const captionMode = message.length <= 1024;
    if (captionMode) {
      console.log(`  send mode: caption (msg=${message.length}B <= 1024)`);
      await client.sendFile(peer, { file, caption: message });
    } else {
      console.log(`  send mode: two_bubble (msg=${message.length}B > 1024)`);
      await client.sendFile(peer, { file });
      try {
        await client.sendMessage(peer, { message });
      } catch (err) {
        const e = err as Error;
        return { ok: false, reason: `image sent, text failed: ${e.message || String(err)}` };
      }
    }

    if (peer instanceof Api.User) {
      peerPhoneByUserId.set(peer.id.toString(), phoneDigits);
    }
    return { ok: true };
  } catch (err) {
    const e = err as Error;
    const msg = e.message || String(err);
    if (/PHONE_NOT_OCCUPIED|USER_NOT_FOUND|PHONE_NUMBER_INVALID|PEER_ID_INVALID/i.test(msg)) {
      return { ok: false, reason: 'phone number not on Telegram' };
    }
    return { ok: false, reason: `mtproto exception: ${msg}` };
  }
}
```

- [ ] **Step 5: Update the call site in `main()`**

Find the `result = await sendViaMTProto(client, proposal.customer_phone, proposal.message);` line in `main()` (around line 383). The signature changed — replace with:

```ts
      result = await sendViaMTProto(client, proposal._id, proposal.customer_phone, proposal.message);
```

- [ ] **Step 6: Type-check the worker**

```powershell
cd scripts\telegram-worker
npx tsc --noEmit
cd ..\..
```
Expected: no errors. If you see "Cannot find name 'CustomFile'", check the gramjs version supports that import path; alternative is `import { CustomFile } from 'telegram/client/uploads.js'` or similar — adjust the import path to match the installed `telegram` package's actual export.

- [ ] **Step 7: End-to-end smoke — caption mode**

In the dashboard, generate a batch and approve one proposal targeted at a test phone (kasing/+85570597666). Make sure the message is short (≤1024 chars). Start the worker:

```powershell
cd scripts\telegram-worker
npm start
```

Expected console output includes:
- `→ sending to ... +85570597666`
- `image: default brand.jpg <bytes>B`
- `send mode: caption (msg=<n>B <= 1024)`
- `✓ sent (1/15 today)`

Open Telegram on the test phone — verify a single bubble with the image and the message as caption.

- [ ] **Step 8: End-to-end smoke — two-bubble mode**

In the dashboard, edit a pending proposal's textarea so the message is over 1024 chars (paste a long lorem ipsum). Save the draft, approve it, and let the worker pick it up.

Expected console output: `send mode: two_bubble`. Telegram receives image bubble, then text bubble. Both should arrive.

- [ ] **Step 9: End-to-end smoke — custom image override**

Generate a fresh proposal, attach a custom image via `POST /:id/image` (any different image than the default), then approve.

Expected console output: `image: proposal_custom <filename> <bytes>B`. Telegram receives the custom image, not the default.

- [ ] **Step 10: Commit**

```powershell
git add scripts/telegram-worker/worker.ts
git commit -m "Worker fetches effective image and smart-splits send

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Dashboard — default image card

**Files:**
- Modify: `src/reports/templates/crm/outreach.hbs`

- [ ] **Step 1: Verify current state**

```powershell
Select-String -Path src\reports\templates\crm\outreach.hbs -Pattern "default-image"
```
Expected: no matches.

- [ ] **Step 2: Add CSS for the card**

In `src/reports/templates/crm/outreach.hbs`, find the closing `</style>` tag (around line 194) and insert these rules right before it:

```css
  .default-image-card {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 0.85rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }
  .default-image-thumb {
    width: 80px;
    height: 80px;
    border-radius: 6px;
    object-fit: cover;
    background: var(--bg);
    border: 1px solid var(--border);
    cursor: pointer;
  }
  .default-image-thumb.empty {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    font-size: 0.8rem;
    font-family: var(--font-mono);
  }
  .default-image-meta { display: flex; flex-direction: column; gap: 0.15rem; flex: 1 1 200px; min-width: 0; }
  .default-image-meta .name { font-size: 0.92rem; color: var(--text); }
  .default-image-meta .sub { font-size: 0.78rem; color: var(--text-muted); font-family: var(--font-mono); }
  .default-image-actions { display: flex; gap: 0.5rem; }
  .image-setup-banner {
    background: var(--red);
    color: var(--bg);
    border-radius: var(--radius);
    padding: 0.6rem 0.85rem;
    margin-bottom: 0.75rem;
    font-size: 0.85rem;
    font-weight: 500;
  }
  .image-setup-banner.hidden { display: none; }
  .lightbox-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.85);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    cursor: zoom-out;
  }
  .lightbox-backdrop.show { display: flex; }
  .lightbox-backdrop img { max-width: 92vw; max-height: 92vh; }
```

- [ ] **Step 3: Add the card markup**

Find `<div class="outreach-wrap">` (around line 196) and insert this block right after it (before the existing `<div class="pause-banner" ...>`):

```html
  <div class="image-setup-banner hidden" id="image-setup-banner">⚠ Upload a default brand image below to enable outreach.</div>
  <div class="default-image-card">
    <img class="default-image-thumb" id="default-image-thumb" alt="Default brand image" onclick="openLightbox()">
    <div class="default-image-meta">
      <div class="name" id="default-image-name">Loading…</div>
      <div class="sub" id="default-image-sub"></div>
    </div>
    <div class="default-image-actions">
      <input type="file" id="default-image-file" accept="image/jpeg,image/png,image/webp" style="display:none" onchange="uploadDefaultImage(event)">
      <button class="btn btn-primary" onclick="document.getElementById('default-image-file').click()">Replace image</button>
    </div>
  </div>
  <div class="lightbox-backdrop" id="lightbox" onclick="closeLightbox()">
    <img id="lightbox-img" alt="Full size">
  </div>
```

- [ ] **Step 4: Add the JS for default-image management**

At the very top of the existing `<script>` block (around line 226, just after `const API = '/crm/api/outreach';`), insert:

```js
  const DEFAULT_IMAGE_URL = API + '/default-image';
  let hasDefaultImage = false;

  async function refreshDefaultImage() {
    const thumb = document.getElementById('default-image-thumb');
    const name = document.getElementById('default-image-name');
    const sub = document.getElementById('default-image-sub');
    const banner = document.getElementById('image-setup-banner');
    const genBtn = document.querySelector('.generate-bar .btn-primary');

    try {
      const resp = await fetch(DEFAULT_IMAGE_URL + '?cb=' + Date.now(), { credentials: 'same-origin' });
      if (resp.status === 404) {
        hasDefaultImage = false;
        thumb.removeAttribute('src');
        thumb.classList.add('empty');
        thumb.alt = '(none)';
        thumb.textContent = '(none)';
        name.textContent = 'No default image set';
        sub.textContent = 'Upload one to enable outreach';
        banner.classList.remove('hidden');
        if (genBtn) genBtn.disabled = true;
        return;
      }
      if (!resp.ok) throw new Error('GET default-image ' + resp.status);
      hasDefaultImage = true;
      const blob = await resp.blob();
      thumb.classList.remove('empty');
      thumb.src = URL.createObjectURL(blob);
      thumb.textContent = '';
      const filename = decodeURIComponent(resp.headers.get('x-filename') || 'image');
      const sizeKb = Math.round(blob.size / 1024);
      name.textContent = filename;
      sub.textContent = blob.type + ' · ' + sizeKb + ' KB';
      banner.classList.add('hidden');
      if (genBtn) genBtn.disabled = false;
    } catch (err) {
      console.error('refreshDefaultImage', err);
    }
  }

  async function uploadDefaultImage(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    showToast('Uploading…', 'success');
    try {
      const resp = await fetch(DEFAULT_IMAGE_URL, { method: 'POST', credentials: 'same-origin', body: fd });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) { showToast('Default image updated', 'success'); refreshDefaultImage(); }
      else { showToast(data.error || ('Upload failed: ' + resp.status), 'error'); }
    } catch (err) {
      showToast('Upload failed', 'error');
    } finally {
      ev.target.value = '';
    }
  }

  function openLightbox() {
    if (!hasDefaultImage) return;
    const lb = document.getElementById('lightbox');
    const img = document.getElementById('lightbox-img');
    img.src = document.getElementById('default-image-thumb').src;
    lb.classList.add('show');
  }
  function closeLightbox() {
    document.getElementById('lightbox').classList.remove('show');
  }
```

- [ ] **Step 5: Wire `refreshDefaultImage` into page load**

Find the bottom of the script block (around line 489–490) where `startWorkerStatusPoll(); loadList();` are called. Add `refreshDefaultImage();` as the first call:

```js
  refreshDefaultImage();
  startWorkerStatusPoll();
  loadList();
```

- [ ] **Step 6: Build and verify in browser**

```powershell
npm run build
npm run dev
```

Open `http://localhost:3000/crm/outreach`. Expected:
- A new card at the top showing the current default image thumbnail (or "No default image set" + red banner if none).
- Clicking the thumbnail opens a lightbox at full size.
- Clicking "Replace image" → file picker → upload → thumbnail updates within ~1s.
- If no default exists, the `Generate batch` button is disabled (greyed out).

- [ ] **Step 7: Mobile sanity check**

In Chrome DevTools, switch to a mobile viewport (375×667). The card should wrap gracefully — thumbnail on the left, name/sub on the right wrapping below, button below that. No horizontal scroll.

- [ ] **Step 8: Commit**

```powershell
git add src/reports/templates/crm/outreach.hbs
git commit -m "Default brand image card with thumbnail, lightbox, and gen-batch gating

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Dashboard — per-proposal editing bar with counter

**Files:**
- Modify: `src/reports/templates/crm/outreach.hbs`

- [ ] **Step 1: Verify current state**

```powershell
Select-String -Path src\reports\templates\crm\outreach.hbs -Pattern "image-bar|effective-image"
```
Expected: no matches.

- [ ] **Step 2: Add CSS for the editing bar**

In the `<style>` block, just before the closing `</style>` (after the `.lightbox-backdrop` rules from Task 8), add:

```css
  .image-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
    padding: 0.4rem 0.5rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    flex-wrap: wrap;
    font-size: 0.78rem;
  }
  .image-bar .thumb {
    width: 40px;
    height: 40px;
    border-radius: 4px;
    object-fit: cover;
    background: var(--surface-2);
    border: 1px solid var(--border);
    cursor: pointer;
    flex: 0 0 auto;
  }
  .image-bar .label { color: var(--text-muted); flex: 1 1 auto; min-width: 80px; }
  .image-bar .label.custom { color: var(--accent); }
  .image-bar .actions { display: flex; gap: 0.4rem; }
  .image-bar .icon-btn {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    border-radius: 4px;
    padding: 0.2rem 0.55rem;
    cursor: pointer;
    font-family: var(--font-body);
    font-size: 0.78rem;
  }
  .image-bar .icon-btn:hover { border-color: var(--accent); }
  .image-bar .icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .image-bar .counter {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    flex: 0 0 auto;
  }
  .image-bar .counter.green { color: var(--green); }
  .image-bar .counter.yellow { color: var(--yellow); }
  .image-bar .counter.red { color: var(--red); }
```

- [ ] **Step 3: Update `renderProposals` to emit the editing bar**

In the script section, find the `renderProposals` function (around line 307). Inside the `proposals.map(p => { ... })` block, after the existing `const editable = ...` line, add:

```js
      const customClass = p.custom_image_id ? 'custom' : '';
      const customLabel = p.custom_image_id ? 'Custom image' : 'Default image';
      const customDisabled = p.custom_image_id ? '' : 'disabled';
      const imageBarReadonly = p.status === 'pending' ? '' : 'disabled';
```

Then in the same function, find the section that emits `'<textarea class="proposal-message" ...></textarea>'` — directly after that textarea line and before the `proposal-actions` div, insert this block:

```js
          '<div class="image-bar">' +
            '<img class="thumb" id="img-' + p._id + '" src="' + esc(API + '/' + p._id + '/effective-image?cb=' + Date.now()) + '" onclick="openProposalLightbox(\'' + p._id + '\')" alt="image">' +
            '<span class="label ' + customClass + '" id="img-label-' + p._id + '">' + customLabel + '</span>' +
            '<input type="file" id="img-file-' + p._id + '" accept="image/jpeg,image/png,image/webp" style="display:none" onchange="uploadCustomImage(\'' + p._id + '\', event)">' +
            '<div class="actions">' +
              '<button class="icon-btn" onclick="document.getElementById(\'img-file-' + p._id + '\').click()" ' + imageBarReadonly + '>📎 Replace</button>' +
              '<button class="icon-btn" onclick="clearCustomImage(\'' + p._id + '\')" ' + customDisabled + ' ' + imageBarReadonly + ' id="img-clear-' + p._id + '">↺ Use default</button>' +
            '</div>' +
            '<span class="counter" id="counter-' + p._id + '">0 / 1024</span>' +
          '</div>' +
```

- [ ] **Step 4: Wire counter updates and Save/Approve gating**

In the script section, near the existing helper functions (after `function esc(s)`), add:

```js
  function counterClass(len) {
    if (len > 4096) return 'red';
    if (len > 1024) return 'yellow';
    return 'green';
  }
  function updateCounter(id) {
    const ta = document.getElementById('m-' + id);
    const counter = document.getElementById('counter-' + id);
    if (!ta || !counter) return;
    const len = ta.value.length;
    counter.textContent = len + ' / 1024';
    counter.classList.remove('green', 'yellow', 'red');
    counter.classList.add(counterClass(len));
    counter.title = len > 1024 && len <= 4096
      ? 'Will send as image then separate text — over caption limit.'
      : (len > 4096 ? 'Too long for Telegram — shorten before approving.' : '');

    // Disable Save and Approve when over 4096
    const card = document.getElementById('p-' + id);
    if (!card) return;
    const buttons = card.querySelectorAll('.proposal-actions .btn-primary');
    buttons.forEach((b) => { b.disabled = len > 4096; });
  }

  async function uploadCustomImage(id, ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    showToast('Uploading…', 'success');
    try {
      const resp = await fetch(API + '/' + id + '/image', { method: 'POST', credentials: 'same-origin', body: fd });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        showToast('Custom image attached', 'success');
        const thumb = document.getElementById('img-' + id);
        const label = document.getElementById('img-label-' + id);
        const clearBtn = document.getElementById('img-clear-' + id);
        if (thumb) thumb.src = API + '/' + id + '/effective-image?cb=' + Date.now();
        if (label) { label.textContent = 'Custom image'; label.classList.add('custom'); }
        if (clearBtn) clearBtn.disabled = false;
      } else {
        showToast(data.error || ('Upload failed: ' + resp.status), 'error');
      }
    } catch (err) {
      showToast('Upload failed', 'error');
    } finally {
      ev.target.value = '';
    }
  }

  async function clearCustomImage(id) {
    try {
      const resp = await fetch(API + '/' + id + '/image', { method: 'DELETE', credentials: 'same-origin' });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        showToast('Reverted to default', 'success');
        const thumb = document.getElementById('img-' + id);
        const label = document.getElementById('img-label-' + id);
        const clearBtn = document.getElementById('img-clear-' + id);
        if (thumb) thumb.src = API + '/' + id + '/effective-image?cb=' + Date.now();
        if (label) { label.textContent = 'Default image'; label.classList.remove('custom'); }
        if (clearBtn) clearBtn.disabled = true;
      } else {
        showToast(data.error || ('Revert failed: ' + resp.status), 'error');
      }
    } catch (err) {
      showToast('Revert failed', 'error');
    }
  }

  function openProposalLightbox(id) {
    const lb = document.getElementById('lightbox');
    const img = document.getElementById('lightbox-img');
    img.src = API + '/' + id + '/effective-image?cb=' + Date.now();
    lb.classList.add('show');
  }
```

- [ ] **Step 5: Wire `updateCounter` to the textarea and initial render**

Find the `renderProposals` function. After the `list.innerHTML = ...` assignment (and before the `setTimeout(maybeFocus, 50);` line), insert this block to attach input listeners and seed the counter:

```js
    proposals.forEach((p) => {
      const ta = document.getElementById('m-' + p._id);
      if (ta) {
        ta.addEventListener('input', () => updateCounter(p._id));
        updateCounter(p._id);
      }
    });
```

- [ ] **Step 6: Build and browser-verify counter colors**

```powershell
npm run build
npm run dev
```

Open `/crm/outreach` with a pending proposal. Expected:
- Counter under each proposal shows `<n> / 1024`.
- Edit the textarea: counter updates live.
- Length 0–1024 → counter green.
- Length 1025–4096 → counter yellow, hovering shows "Will send as image then separate text — over caption limit."
- Length 4097+ → counter red, Save and Approve buttons greyed out.

- [ ] **Step 7: Browser-verify the image bar**

On the same page, for any pending proposal:
- Image thumb is the default brand image. Label says "Default image". `↺ Use default` button is greyed out.
- Click `📎 Replace` → file picker → upload a different image. Thumb updates, label flips to green "Custom image", `↺ Use default` becomes clickable.
- Click `↺ Use default` → thumb reverts, label flips back, button greys out again.
- Click the thumbnail → lightbox opens with the proposal's effective image.

For non-pending proposals (Approved / Sent tabs), the image bar buttons should be `disabled` (greyed out) and the textarea is `readonly`.

- [ ] **Step 8: Mobile sanity check**

In DevTools mobile viewport (375×667), the bar wraps:
1. `[thumb] [label]`
2. `[Replace] [Use default]`
3. `counter`

No horizontal scroll.

- [ ] **Step 9: Commit**

```powershell
git add src/reports/templates/crm/outreach.hbs
git commit -m "Per-proposal editing bar with thumb, replace/revert, and length counter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: End-to-end test on real test phones

**Files:** none (manual verification)

This is the final smoke test. The two test phones from `outreach.hbs:215` are kasing/+85570597666 and Chan kasing/+85511228226 (both belong to you).

- [ ] **Step 1: Pre-flight**

- The default brand image is uploaded.
- `npm run dev` is running.
- The worker is running (`cd scripts/telegram-worker; npm start`) with a fresh string session and `INBOUND_DISABLED=false`.
- The dashboard (`/crm/outreach`) is open.

- [ ] **Step 2: Caption-mode send to kasing**

Click "Test on me (kasing / Chan kasing)" → confirm. Two proposals appear in Pending. For the kasing one (+85570597666), make sure the textarea content is short (≤1024). Click Approve.

Watch the worker logs:
- `→ sending to ... +85570597666`
- `image: default <filename> <bytes>B`
- `send mode: caption (msg=<n>B <= 1024)`
- `✓ sent (X/15 today)`

Open Telegram on the kasing phone — verify exactly **one bubble** with the default image and the caption underneath.

- [ ] **Step 3: Two-bubble-mode send to Chan kasing**

For the Chan kasing proposal (+85511228226), edit the textarea to a long body (paste 1500+ chars of lorem ipsum). The counter should turn yellow. Save the draft, then Approve.

Worker logs should show: `send mode: two_bubble`. On the Chan kasing phone, verify **image bubble first, then text bubble** — both arrive.

- [ ] **Step 4: Custom override**

Generate one more test proposal. Before approving, click `📎 Replace` and upload a different image (any second test image). Counter is green (short message). Approve.

Worker logs should show: `image: proposal_custom <new filename> <bytes>B`. Telegram receives the custom image, not the default brand card.

- [ ] **Step 5: Replace default mid-flight**

Generate a proposal but don't approve yet. Replace the default image via the dashboard card with a new image. Now approve.

Worker logs should show: `image: default <new filename>`. Telegram receives the new default. Confirms the resolution-at-send-time semantics from the spec.

- [ ] **Step 6: Failure path — image fetch fails**

Stop the dev server briefly while the worker has an approved proposal queued (or temporarily edit `EFFECTIVE_IMAGE_URL` to a broken path and restart). The worker should log:
- `effective-image <status>: ...`
- `✗ failed: image fetch failed (no default or worker auth issue)`

The proposal flips to **Failed** status on the dashboard with that reason. Restart the dev server normally.

- [ ] **Step 7: No final commit needed for Step 10**

This task is verification only — nothing to commit. If you found bugs along the way that you fixed inline, those are their own commits.

---

## Self-review checklist (engineer should run this before marking the plan done)

- [ ] All 10 tasks pass their verification steps.
- [ ] `npm run build` succeeds with no TypeScript errors.
- [ ] `npm run typecheck` succeeds.
- [ ] The Failed tab on the dashboard contains no spurious entries from your testing — clean up via the existing "Clear all" button if needed before declaring done.
- [ ] The default image is set in production-ready state (not your random test image).

---

## Known follow-ups (out of scope, mentioned in spec)

- 30-day janitor for orphaned `outreach_images` docs whose proposals are `sent`/`skipped`/`failed`. Build when the collection grows.
- Versioning of past defaults. Build when needed.
- Drag-drop / cropping. Build when needed.
- Per-image-bar pre-send preview modal showing the actual Telegram bubble layout. Build when needed.
