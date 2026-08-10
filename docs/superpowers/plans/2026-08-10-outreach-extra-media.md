# Outreach Extra Media (Add Image / Add Video) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace attach more than one default image and more than one
default video to outreach sends via new "Add image" / "Add video" buttons,
without changing any existing "Replace" / "Remove" behavior, gated only by a
shared 50 MB byte budget (not an item count).

**Architecture:** Existing primary image (`outreach_images`, `_id:
defaultDocKey(org)`) and primary video (`outreach_media`, same key scheme)
collections are untouched. "Extras" are new documents in the *same*
collections with their own `ObjectId` and an `org_id` field, added via new
`POST .../extra` endpoints and listed/removed independently. A new
`GET /:id/effective-media` endpoint returns the full ordered fetch list
(images then videos) for a proposal's send, replacing the worker's two
separate fetches (`fetchEffectiveImage` + `fetchDefaultVideo`) with one call
that feeds the same `mediaPaths` loop that already handles N items.

**Tech Stack:** TypeScript / Express / MongoDB driver / multer / AWS S3 SDK
(R2) / gramjs (worker) / Handlebars (dashboard template). No test framework
in this repo — verification is a standalone `ts-node` script that hits real
routes/repositories against the dev database, following the existing
`scripts/check-*.{js,ts}` and `scripts/backfill-*.ts` conventions.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-10-outreach-extra-media-design.md`
  (read it before starting — it has full rationale for every decision below).
- Shared budget is **50 MB total** (`MEDIA_BUDGET_BYTES = 50 * 1024 * 1024`)
  across primary image + primary video + all extra images + all extra videos,
  **per org**. No cap on item count.
- Do NOT touch `/:id/effective-image` or `/default-video-url` behavior — the
  dashboard's proposal thumbnails/lightbox call `/:id/effective-image`
  directly and must keep working unmodified.
- Do NOT add a gate requiring a default image to exist — none exists today
  (`POST /generate` and `sendViaMTProto` already treat all media as optional).
- Verification scripts must never call `POST /default-image` or
  `POST /default-video` (the *replace* routes) against the real `company` /
  `personal` orgs — that would overwrite live production branding. Only
  exercise the new `extra` endpoints (additive, independently removable) and
  clean up everything they create.
- Follow existing code patterns exactly (see Task 1 for the repository style
  to match, Task 2 for the route style to match).

---

## Task 1: Repository layer — extra media + shared budget helper

**Files:**
- Modify: `src/outreach/outreach-images-repository.ts`
- Modify: `src/outreach/outreach-video-repository.ts`
- Create: `src/outreach/outreach-media-budget.ts`
- Create: `scripts/check-outreach-extra-media.ts`

**Interfaces:**
- Produces: `OutreachImagesRepository.listExtras(orgId)`,
  `.addExtra(input, orgId): Promise<ObjectId>`,
  `.removeExtra(id): Promise<boolean>`, `.sumExtraBytes(orgId): Promise<number>`.
- Produces: `OutreachVideoRepository.listExtras(orgId)`,
  `.addExtra(input, orgId): Promise<ObjectId>`,
  `.removeExtra(id): Promise<string | null>` (returns removed `r2_key` for
  the caller to delete from R2), `.sumExtraBytes(orgId): Promise<number>`.
- Produces: `MEDIA_BUDGET_BYTES` (number, `52428800`), `getMediaUsage(orgId):
  Promise<{ totalBytes: number; budgetBytes: number }>`,
  `checkBudget(orgId, additionalBytes, excludeCurrentPrimaryBytes?):
  Promise<{ ok: true } | { ok: false; totalBytes: number; budgetBytes:
  number; attemptedBytes: number }>` — from `src/outreach/outreach-media-budget.ts`.
  `excludeCurrentPrimaryBytes` lets a *replace* of the primary subtract the
  old primary's size before adding the new one's, so replacing-in-place never
  spuriously trips the budget.

- [ ] **Step 1: Add `extra` to the image-kind union and `org_id` field**

In `src/outreach/outreach-images-repository.ts`, change:

```ts
export type ImageKind = 'default' | 'proposal_custom';

export interface OutreachImageDocument {
  // Per-org default images use a string _id (defaultDocKey(orgId), e.g.
  // 'default:company'); per-proposal custom images use an ObjectId.
  _id: ObjectId | string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  data: Binary;
  uploaded_at: Date;
  uploaded_by: string;
  kind: ImageKind;
}
```

to:

```ts
export type ImageKind = 'default' | 'proposal_custom' | 'extra';

export interface OutreachImageDocument {
  // Per-org default images use a string _id (defaultDocKey(orgId), e.g.
  // 'default:company'); per-proposal custom images and 'extra' (additional
  // default) images use an ObjectId. org_id is only set on 'extra' docs —
  // 'default' docs are org-scoped via their _id, 'proposal_custom' docs are
  // scoped implicitly through the proposal that references them.
  _id: ObjectId | string;
  org_id?: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  data: Binary;
  uploaded_at: Date;
  uploaded_by: string;
  kind: ImageKind;
}
```

- [ ] **Step 2: Add extra-image methods to `OutreachImagesRepository`**

Add these methods to the class, after `insertCustom`/`deleteCustom`:

```ts
  /** List this org's extra (additional) default images, oldest first —
   *  ObjectId is chronological, so sorting by _id gives add-order for free. */
  async listExtras(orgId: OrgId = DEFAULT_ORG): Promise<OutreachImageDocument[]> {
    return this.col.find({ kind: 'extra', org_id: orgId } as any).sort({ _id: 1 }).toArray();
  }

  async addExtra(input: {
    filename: string;
    mime_type: string;
    buffer: Buffer;
    uploaded_by: string;
  }, orgId: OrgId = DEFAULT_ORG): Promise<ObjectId> {
    const oid = new ObjectId();
    const doc: OutreachImageDocument = {
      _id: oid,
      org_id: orgId,
      filename: input.filename,
      mime_type: input.mime_type,
      size_bytes: input.buffer.length,
      data: new Binary(input.buffer),
      uploaded_at: new Date(),
      uploaded_by: input.uploaded_by,
      kind: 'extra',
    };
    await this.col.insertOne(doc as any);
    return oid;
  }

  async removeExtra(id: string | ObjectId): Promise<boolean> {
    try {
      const oid = typeof id === 'string' ? new ObjectId(id) : id;
      const result = await this.col.deleteOne({ _id: oid, kind: 'extra' } as any);
      return result.deletedCount === 1;
    } catch {
      return false;
    }
  }

  async sumExtraBytes(orgId: OrgId = DEFAULT_ORG): Promise<number> {
    const docs = await this.col
      .find({ kind: 'extra', org_id: orgId } as any)
      .project({ size_bytes: 1 })
      .toArray();
    return docs.reduce((sum, d: any) => sum + (d.size_bytes || 0), 0);
  }
```

- [ ] **Step 3: Add extra-video document type + methods to `OutreachVideoRepository`**

In `src/outreach/outreach-video-repository.ts`, add after the existing
`OutreachVideoDocument` interface:

```ts
export interface OutreachExtraVideoDocument {
  _id: ObjectId;
  org_id: string;
  r2_key: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: Date;
  uploaded_by: string;
}
```

Update the imports at the top of the file to add `ObjectId`:

```ts
import { Collection, ObjectId } from 'mongodb';
```

Add a second typed collection handle in the constructor (same underlying
Mongo collection, different TS shape — Mongo doesn't enforce a schema, this
is purely for type safety on each method group) and the new methods:

```ts
export class OutreachVideoRepository {
  private col: Collection<OutreachVideoDocument>;
  private extraCol: Collection<OutreachExtraVideoDocument>;

  constructor() {
    const db = DatabaseConnection.getInstance().getDb();
    this.col = db.collection<OutreachVideoDocument>(COLLECTION);
    this.extraCol = db.collection<OutreachExtraVideoDocument>(COLLECTION);
  }

  // ... existing getDefault / setDefault / clearDefault unchanged ...

  /** List this org's extra (additional) default videos, oldest first. */
  async listExtras(orgId: OrgId = DEFAULT_ORG): Promise<OutreachExtraVideoDocument[]> {
    return this.extraCol.find({ org_id: orgId }).sort({ _id: 1 }).toArray();
  }

  async addExtra(input: {
    r2_key: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
    uploaded_by: string;
  }, orgId: OrgId = DEFAULT_ORG): Promise<ObjectId> {
    const oid = new ObjectId();
    const doc: OutreachExtraVideoDocument = {
      _id: oid,
      org_id: orgId,
      r2_key: input.r2_key,
      filename: input.filename,
      mime_type: input.mime_type,
      size_bytes: input.size_bytes,
      uploaded_at: new Date(),
      uploaded_by: input.uploaded_by,
    };
    await this.extraCol.insertOne(doc);
    return oid;
  }

  /** Removes the metadata doc; returns the removed r2_key (caller deletes
   *  the R2 object) or null if no such extra existed. */
  async removeExtra(id: string | ObjectId): Promise<string | null> {
    try {
      const oid = typeof id === 'string' ? new ObjectId(id) : id;
      const doc = await this.extraCol.findOne({ _id: oid });
      if (!doc) return null;
      await this.extraCol.deleteOne({ _id: oid });
      return doc.r2_key;
    } catch {
      return null;
    }
  }

  async sumExtraBytes(orgId: OrgId = DEFAULT_ORG): Promise<number> {
    const docs = await this.extraCol.find({ org_id: orgId }).project({ size_bytes: 1 }).toArray();
    return docs.reduce((sum, d) => sum + (d.size_bytes || 0), 0);
  }
}
```

- [ ] **Step 4: Write the shared media-budget module**

Create `src/outreach/outreach-media-budget.ts`:

```ts
// src/outreach/outreach-media-budget.ts
/**
 * Shared byte budget across ALL default outreach media for an org — primary
 * image, primary video, and every extra image/video. There is no per-item
 * count cap; only this combined size gates adding more media. See
 * docs/superpowers/specs/2026-08-10-outreach-extra-media-design.md.
 */
import { OutreachImagesRepository } from './outreach-images-repository';
import { OutreachVideoRepository } from './outreach-video-repository';
import { OrgId, DEFAULT_ORG } from './orgs';

export const MEDIA_BUDGET_BYTES = 50 * 1024 * 1024; // 50MB

export interface MediaUsage {
  totalBytes: number;
  budgetBytes: number;
}

export async function getMediaUsage(orgId: OrgId = DEFAULT_ORG): Promise<MediaUsage> {
  const imagesRepo = new OutreachImagesRepository();
  const videoRepo = new OutreachVideoRepository();
  const [primaryImage, primaryVideo, extraImageBytes, extraVideoBytes] = await Promise.all([
    imagesRepo.getDefault(orgId),
    videoRepo.getDefault(orgId),
    imagesRepo.sumExtraBytes(orgId),
    videoRepo.sumExtraBytes(orgId),
  ]);
  const totalBytes =
    (primaryImage?.size_bytes || 0) +
    (primaryVideo?.size_bytes || 0) +
    extraImageBytes +
    extraVideoBytes;
  return { totalBytes, budgetBytes: MEDIA_BUDGET_BYTES };
}

export type BudgetCheck =
  | { ok: true }
  | { ok: false; totalBytes: number; budgetBytes: number; attemptedBytes: number };

/**
 * Would adding `additionalBytes` push the org over budget? Pass
 * `excludeCurrentPrimaryBytes` when replacing a primary doc in place (its old
 * size shouldn't count against the new upload — a same-size replace should
 * never trip the budget).
 */
export async function checkBudget(
  orgId: OrgId,
  additionalBytes: number,
  excludeCurrentPrimaryBytes = 0
): Promise<BudgetCheck> {
  const usage = await getMediaUsage(orgId);
  const projected = usage.totalBytes - excludeCurrentPrimaryBytes + additionalBytes;
  if (projected > MEDIA_BUDGET_BYTES) {
    return { ok: false, totalBytes: usage.totalBytes, budgetBytes: MEDIA_BUDGET_BYTES, attemptedBytes: additionalBytes };
  }
  return { ok: true };
}
```

- [ ] **Step 5: Write the verification script (repository layer only)**

Create `scripts/check-outreach-extra-media.ts`. This is the first section —
later tasks append more sections to this same file (route-level, then
manifest-level checks), matching the incremental style of
`scripts/check-outreach-schedule-setting.js`.

```ts
/**
 * Verification for the outreach "extra media" feature (Add image / Add
 * video buttons + shared 50MB budget). Exercises real repositories and
 * routes against the dev database — NEVER calls the primary replace routes
 * (POST /default-image, POST /default-video) since those would overwrite
 * live production branding for the company/personal orgs. Only touches
 * 'extra' docs it creates itself, and deletes them all before exiting.
 *
 * Usage: npx ts-node scripts/check-outreach-extra-media.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import DatabaseConnection from '../src/database/connection';
import { OutreachImagesRepository } from '../src/outreach/outreach-images-repository';
import { OutreachVideoRepository } from '../src/outreach/outreach-video-repository';
import { getMediaUsage, checkBudget, MEDIA_BUDGET_BYTES } from '../src/outreach/outreach-media-budget';
import { ObjectId } from 'mongodb';

const TEST_ORG = 'company';
let failures = 0;
const cleanup: Array<() => Promise<void>> = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

async function main(): Promise<void> {
  const db = DatabaseConnection.getInstance();
  await db.connect();

  const imagesRepo = new OutreachImagesRepository();
  const videoRepo = new OutreachVideoRepository();

  // --- Task 1: repository layer ---
  const baseline = await getMediaUsage(TEST_ORG);
  console.log(`baseline usage for ${TEST_ORG}: ${baseline.totalBytes} / ${baseline.budgetBytes} bytes`);

  const imgBuf = Buffer.from('fake-jpeg-bytes-for-testing');
  const imgId = await imagesRepo.addExtra({
    filename: 'test-extra.jpg',
    mime_type: 'image/jpeg',
    buffer: imgBuf,
    uploaded_by: 'check-script',
  }, TEST_ORG);
  cleanup.push(async () => { await imagesRepo.removeExtra(imgId); });

  const listedImages = await imagesRepo.listExtras(TEST_ORG);
  check('extra image appears in listExtras', listedImages.some((d) => String(d._id) === String(imgId)), true);

  const imageBytesAfterAdd = await imagesRepo.sumExtraBytes(TEST_ORG);
  check('sumExtraBytes reflects the added image', imageBytesAfterAdd, imgBuf.length);

  const usageAfterImage = await getMediaUsage(TEST_ORG);
  check('getMediaUsage total grows by the image size', usageAfterImage.totalBytes, baseline.totalBytes + imgBuf.length);

  const removedImage = await imagesRepo.removeExtra(imgId);
  check('removeExtra reports success', removedImage, true);
  const usageAfterImageRemove = await getMediaUsage(TEST_ORG);
  check('getMediaUsage returns to baseline after removing the extra image', usageAfterImageRemove.totalBytes, baseline.totalBytes);
  cleanup.pop(); // already removed above, no double-cleanup needed

  const overBudget = await checkBudget(TEST_ORG, MEDIA_BUDGET_BYTES + 1);
  check('checkBudget rejects a file larger than the whole budget', overBudget.ok, false);

  const wayOverBudget = await checkBudget(TEST_ORG, MEDIA_BUDGET_BYTES * 2);
  check('checkBudget reports the attempted size on rejection', !wayOverBudget.ok && wayOverBudget.attemptedBytes, MEDIA_BUDGET_BYTES * 2);

  const smallOk = await checkBudget(TEST_ORG, 100);
  check('checkBudget allows a small file when far under budget', smallOk.ok, true);

  // A fake ObjectId lookup returns null cleanly (no throw) for video extras.
  const missingVideoRemove = await videoRepo.removeExtra(new ObjectId());
  check('removeExtra returns null for a non-existent id', missingVideoRemove, null);

  // Cleanup any leftovers (defensive — steps above already clean as they go).
  for (const fn of cleanup) await fn();

  await db.disconnect();

  if (failures) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nPASS  all outreach extra-media checks');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 6: Run the script and verify all checks PASS**

Run: `npx ts-node scripts/check-outreach-extra-media.ts`
Expected: every line starts `PASS`, ending with `PASS  all outreach
extra-media checks`. If `DatabaseConnection` fails to connect, confirm
`.env` has `MONGODB_URI` set (same as any other script in this repo).

- [ ] **Step 7: Commit**

```bash
git add src/outreach/outreach-images-repository.ts src/outreach/outreach-video-repository.ts src/outreach/outreach-media-budget.ts scripts/check-outreach-extra-media.ts
git commit -m "feat(outreach): add extra-media repository methods and shared budget helper"
```

---

## Task 2: Wire the budget check into primary replace + extra-image API routes

**Files:**
- Modify: `src/api/outreach-routes.ts`
- Modify: `scripts/check-outreach-extra-media.ts`

**Interfaces:**
- Consumes: `MEDIA_BUDGET_BYTES`, `checkBudget`, `getMediaUsage` (Task 1).
  `OutreachImagesRepository.{listExtras,addExtra,removeExtra}` (Task 1).
- Produces: `GET/POST /default-image/extra`, `GET /default-image/extra/:id`,
  `DELETE /default-image/extra/:id` routes. Primary `POST /default-image`
  now budget-checked (still same URL/behavior otherwise).

- [ ] **Step 1: Replace the per-file size constants with the shared budget**

In `src/api/outreach-routes.ts`, change:

```ts
const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } });

const ALLOWED_VIDEO_MIME = ['video/mp4'];
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB
const videoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_VIDEO_BYTES } });
```

to:

```ts
import { MEDIA_BUDGET_BYTES, getMediaUsage, checkBudget } from '../outreach/outreach-media-budget';

const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
// Per-file multer ceiling matches the shared budget — a single file can never
// legitimately exceed it. The real gate is checkBudget() inside each route,
// which accounts for everything else already uploaded for the org.
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_BUDGET_BYTES } });

const ALLOWED_VIDEO_MIME = ['video/mp4'];
const videoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_BUDGET_BYTES } });
```

(Add the import near the other `outreach/` imports at the top of the file,
not inline — this snippet just shows old vs. new for the constants block.)

- [ ] **Step 2: Update the multer error handlers' size wording**

```ts
function imageUploadErrorHandler(err: any, _req: Request, res: Response, next: NextFunction): void {
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.name === 'MulterError' && err.code === 'LIMIT_FILE_SIZE')) {
    res.status(413).json({ error: `File exceeds the ${Math.round(MEDIA_BUDGET_BYTES / 1024 / 1024)} MB shared media budget` });
    return;
  }
  if (err) {
    Logger.error('image upload middleware error', err);
    res.status(400).json({ error: err.message || 'upload error' });
    return;
  }
  next();
}

function videoUploadErrorHandler(err: any, _req: Request, res: Response, next: NextFunction): void {
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.name === 'MulterError' && err.code === 'LIMIT_FILE_SIZE')) {
    res.status(413).json({ error: `File exceeds the ${Math.round(MEDIA_BUDGET_BYTES / 1024 / 1024)} MB shared media budget` });
    return;
  }
  if (err) {
    Logger.error('video upload middleware error', err);
    res.status(400).json({ error: err.message || 'upload error' });
    return;
  }
  next();
}
```

- [ ] **Step 3: Add the budget check to the existing `POST /default-image` (replace)**

Find the existing handler:

```ts
router.post('/default-image', imageUpload.single('file'), imageUploadErrorHandler, async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded (field name: file)' }); return; }
    if (!ALLOWED_IMAGE_MIME.includes(req.file.mimetype)) {
      res.status(400).json({ error: `Mime ${req.file.mimetype} not allowed; use JPEG, PNG, or WebP` });
      return;
    }
    const org = resolveOrg(req);
    const uploadedBy = getSessionUser(req) || 'unknown';
    await new OutreachImagesRepository().setDefault({
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      buffer: req.file.buffer,
      uploaded_by: uploadedBy,
    }, org);
    Logger.info(`outreach default image replaced by ${uploadedBy} for org=${org}: ${req.file.originalname} (${req.file.size}B, ${req.file.mimetype})`);
    res.json({ ok: true, filename: req.file.originalname, size_bytes: req.file.size, mime_type: req.file.mimetype });
  } catch (err) {
    Logger.error('default-image POST failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

Insert a budget check right after resolving `org`, excluding the size of the
doc being replaced (a replace should never trip the budget on its own size):

```ts
router.post('/default-image', imageUpload.single('file'), imageUploadErrorHandler, async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded (field name: file)' }); return; }
    if (!ALLOWED_IMAGE_MIME.includes(req.file.mimetype)) {
      res.status(400).json({ error: `Mime ${req.file.mimetype} not allowed; use JPEG, PNG, or WebP` });
      return;
    }
    const org = resolveOrg(req);
    const imagesRepo = new OutreachImagesRepository();
    const existing = await imagesRepo.getDefault(org);
    const budget = await checkBudget(org, req.file.size, existing?.size_bytes || 0);
    if (!budget.ok) {
      res.status(413).json({
        error: `Uploading this file would exceed the ${Math.round(budget.budgetBytes / 1024 / 1024)} MB shared media budget for this workspace`,
        total_bytes: budget.totalBytes,
        budget_bytes: budget.budgetBytes,
        attempted_bytes: budget.attemptedBytes,
      });
      return;
    }
    const uploadedBy = getSessionUser(req) || 'unknown';
    await imagesRepo.setDefault({
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      buffer: req.file.buffer,
      uploaded_by: uploadedBy,
    }, org);
    Logger.info(`outreach default image replaced by ${uploadedBy} for org=${org}: ${req.file.originalname} (${req.file.size}B, ${req.file.mimetype})`);
    res.json({ ok: true, filename: req.file.originalname, size_bytes: req.file.size, mime_type: req.file.mimetype });
  } catch (err) {
    Logger.error('default-image POST failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 4: Add the extra-image routes**

Place these directly after the existing `DELETE /default-image` route (and
before `GET /default-video`):

```ts
// GET /crm/api/outreach/default-image/extra — list this org's extra images
router.get('/default-image/extra', async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const docs = await new OutreachImagesRepository().listExtras(org);
    res.json(docs.map((d) => ({
      id: String(d._id),
      filename: d.filename,
      mime_type: d.mime_type,
      size_bytes: d.size_bytes,
      uploaded_at: d.uploaded_at,
      uploaded_by: d.uploaded_by,
    })));
  } catch (err) {
    Logger.error('default-image/extra GET failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/default-image/extra — add an extra image (does not
// replace the primary default; independently removable).
router.post('/default-image/extra', imageUpload.single('file'), imageUploadErrorHandler, async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded (field name: file)' }); return; }
    if (!ALLOWED_IMAGE_MIME.includes(req.file.mimetype)) {
      res.status(400).json({ error: `Mime ${req.file.mimetype} not allowed; use JPEG, PNG, or WebP` });
      return;
    }
    const org = resolveOrg(req);
    const budget = await checkBudget(org, req.file.size);
    if (!budget.ok) {
      res.status(413).json({
        error: `Adding this file would exceed the ${Math.round(budget.budgetBytes / 1024 / 1024)} MB shared media budget for this workspace`,
        total_bytes: budget.totalBytes,
        budget_bytes: budget.budgetBytes,
        attempted_bytes: budget.attemptedBytes,
      });
      return;
    }
    const uploadedBy = getSessionUser(req) || 'unknown';
    const id = await new OutreachImagesRepository().addExtra({
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      buffer: req.file.buffer,
      uploaded_by: uploadedBy,
    }, org);
    Logger.info(`outreach extra image added by ${uploadedBy} for org=${org}: ${req.file.originalname} (${req.file.size}B) id=${id}`);
    res.json({ ok: true, id: String(id), filename: req.file.originalname, size_bytes: req.file.size, mime_type: req.file.mimetype });
  } catch (err) {
    Logger.error('default-image/extra POST failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /crm/api/outreach/default-image/extra/:id — bytes for one extra image
// (dashboard thumbnails + worker fetch via effective-media).
router.get('/default-image/extra/:id', async (req: Request, res: Response) => {
  try {
    const doc = await new OutreachImagesRepository().getById(req.params.id);
    if (!doc || doc.kind !== 'extra') { res.status(404).json({ error: 'extra image not found' }); return; }
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('X-Filename', encodeURIComponent(doc.filename));
    res.setHeader('Content-Length', String(doc.size_bytes));
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(doc.data.buffer);
  } catch (err) {
    Logger.error('default-image/extra/:id GET failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /crm/api/outreach/default-image/extra/:id
router.delete('/default-image/extra/:id', async (req: Request, res: Response) => {
  try {
    const removed = await new OutreachImagesRepository().removeExtra(req.params.id);
    Logger.info(`outreach extra image removed by ${getSessionUser(req) || 'unknown'}: id=${req.params.id} (removed=${removed})`);
    res.json({ ok: true, removed });
  } catch (err) {
    Logger.error('default-image/extra/:id DELETE failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 5: Append route-level checks to the verification script**

In `scripts/check-outreach-extra-media.ts`, add near the top (after the
existing imports) an in-process Express app hosting the real router, mirroring
`scripts/check-outreach-schedule-setting.js`:

```ts
import express from 'express';
import outreachRoutes from '../src/api/outreach-routes';
```

Then, before `main()`'s final `db.disconnect()`, insert a new section (after
the Task 1 repository checks, before the `for (const fn of cleanup)` line):

```ts
  // --- Task 2: route layer (extra images) ---
  if (!process.env.DASHBOARD_TOKEN) process.env.DASHBOARD_TOKEN = 'check-script-dashboard-token';
  const app = express();
  app.use('/crm/api/outreach', outreachRoutes);
  const server = await new Promise<import('http').Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind check server');
  const base = `http://127.0.0.1:${address.port}/crm/api/outreach`;
  const authHeaders = { Authorization: `Bearer ${process.env.DASHBOARD_TOKEN}` };

  try {
    const fd = new FormData();
    fd.append('file', new Blob([imgBuf], { type: 'image/jpeg' }), 'route-test.jpg');
    const addResp = await fetch(`${base}/default-image/extra?org=${TEST_ORG}`, {
      method: 'POST',
      headers: authHeaders,
      body: fd,
    });
    check('POST default-image/extra status', addResp.status, 200);
    const added = await addResp.json();
    check('POST default-image/extra returns an id', typeof added.id === 'string' && added.id.length > 0, true);

    const listResp = await fetch(`${base}/default-image/extra?org=${TEST_ORG}`, { headers: authHeaders });
    const list = await listResp.json();
    check('GET default-image/extra lists the added item', list.some((d: any) => d.id === added.id), true);

    const bytesResp = await fetch(`${base}/default-image/extra/${added.id}`, { headers: authHeaders });
    check('GET default-image/extra/:id status', bytesResp.status, 200);
    const bytes = Buffer.from(await bytesResp.arrayBuffer());
    check('GET default-image/extra/:id returns the uploaded bytes', bytes.equals(imgBuf), true);

    const usageResp = await fetch(`${base}/default-media/usage?org=${TEST_ORG}`, { headers: authHeaders });
    check('GET default-media/usage status', usageResp.status, 200);

    const delResp = await fetch(`${base}/default-image/extra/${added.id}`, { method: 'DELETE', headers: authHeaders });
    check('DELETE default-image/extra/:id status', delResp.status, 200);
    const delBody = await delResp.json();
    check('DELETE default-image/extra/:id reports removed', delBody.removed, true);

    const bytesAfterDelete = await fetch(`${base}/default-image/extra/${added.id}`, { headers: authHeaders });
    check('extra image is gone after delete', bytesAfterDelete.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
```

Note: `GET /default-media/usage` will 404/error until Task 3 adds it — that's
expected; this step's checks around it should tolerate that (wrap just that
one fetch+check in case Task 3 hasn't landed yet is unnecessary in practice
since you'll do Task 3 immediately after, but if running Task 2 in isolation,
comment out the `default-media/usage` block until Task 3 exists).

- [ ] **Step 6: Run the script and verify all checks PASS**

Run: `npx ts-node scripts/check-outreach-extra-media.ts`
Expected: all `PASS`, including the new route-level checks. If the
`default-media/usage` checks fail with a 404, that's fine at this point —
skip/comment them until Task 3.

- [ ] **Step 7: Commit**

```bash
git add src/api/outreach-routes.ts scripts/check-outreach-extra-media.ts
git commit -m "feat(outreach): add extra-image API routes with shared budget enforcement"
```

---

## Task 3: Extra-video API routes + usage endpoint

**Files:**
- Modify: `src/api/outreach-routes.ts`
- Modify: `scripts/check-outreach-extra-media.ts`

**Interfaces:**
- Consumes: `OutreachVideoRepository.{listExtras,addExtra,removeExtra}` (Task 1),
  `R2StorageService.{uploadVideo,deleteObject,isConfigured}` (existing).
- Produces: `GET/POST /default-video/extra`, `DELETE /default-video/extra/:id`,
  `GET /default-media/usage`.

- [ ] **Step 1: Add the budget check to the existing `POST /default-video` (replace)**

Same pattern as Task 2 Step 3, applied to the video route. The full current
handler (`src/api/outreach-routes.ts:450-483`):

```ts
router.post('/default-video', videoUpload.single('file'), videoUploadErrorHandler, async (req: Request, res: Response) => {
  try {
    const r2 = new R2StorageService();
    if (!r2.isConfigured()) {
      res.status(503).json({ error: 'R2 storage not configured (set R2_ACCOUNT_ID / R2_ACCESS_KEY / R2_SECRET_KEY / R2_BUCKET)' });
      return;
    }
    if (!req.file) { res.status(400).json({ error: 'No file uploaded (field name: file)' }); return; }
    if (!ALLOWED_VIDEO_MIME.includes(req.file.mimetype)) {
      res.status(400).json({ error: `Mime ${req.file.mimetype} not allowed; use MP4 (video/mp4)` });
      return;
    }

    const org = resolveOrg(req);
    const uploadedBy = getSessionUser(req) || 'unknown';
    const key = await r2.uploadVideo(req.file.buffer, req.file.mimetype);
    const previousKey = await new OutreachVideoRepository().setDefault({
      r2_key: key,
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      size_bytes: req.file.size,
      uploaded_by: uploadedBy,
    }, org);
    // Best-effort: delete the object the metadata previously pointed at.
    if (previousKey && previousKey !== key) {
      await r2.deleteObject(previousKey).catch(() => {});
    }
    Logger.info(`outreach default video replaced by ${uploadedBy} for org=${org}: ${req.file.originalname} (${req.file.size}B) key=${key}`);
    res.json({ ok: true, filename: req.file.originalname, size_bytes: req.file.size, mime_type: req.file.mimetype });
  } catch (err) {
    Logger.error('default-video POST failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

Replace the body from `const org = resolveOrg(req);` through the
`setDefault` call with (this inserts one budget check and reuses a single
`videoRepo` instance in place of the two separate `new
OutreachVideoRepository()` calls the original had):

```ts
    const org = resolveOrg(req);
    const videoRepo = new OutreachVideoRepository();
    const existingVideo = await videoRepo.getDefault(org);
    const budget = await checkBudget(org, req.file.size, existingVideo?.size_bytes || 0);
    if (!budget.ok) {
      res.status(413).json({
        error: `Uploading this file would exceed the ${Math.round(budget.budgetBytes / 1024 / 1024)} MB shared media budget for this workspace`,
        total_bytes: budget.totalBytes,
        budget_bytes: budget.budgetBytes,
        attempted_bytes: budget.attemptedBytes,
      });
      return;
    }
    const uploadedBy = getSessionUser(req) || 'unknown';
    const key = await r2.uploadVideo(req.file.buffer, req.file.mimetype);
    const previousKey = await videoRepo.setDefault({
      r2_key: key,
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      size_bytes: req.file.size,
      uploaded_by: uploadedBy,
    }, org);
```

Everything from the `// Best-effort: delete the object...` comment onward
stays exactly as it is in the original — this only touches the block above it.

- [ ] **Step 2: Add the extra-video routes + usage endpoint**

Place directly after the existing `DELETE /default-video` route:

```ts
// GET /crm/api/outreach/default-video/extra — list this org's extra videos
router.get('/default-video/extra', async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const docs = await new OutreachVideoRepository().listExtras(org);
    res.json(docs.map((d) => ({
      id: String(d._id),
      filename: d.filename,
      mime_type: d.mime_type,
      size_bytes: d.size_bytes,
      uploaded_at: d.uploaded_at,
      uploaded_by: d.uploaded_by,
    })));
  } catch (err) {
    Logger.error('default-video/extra GET failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/default-video/extra — add an extra video (R2 +
// metadata doc). Does not replace the primary default video.
router.post('/default-video/extra', videoUpload.single('file'), videoUploadErrorHandler, async (req: Request, res: Response) => {
  try {
    const r2 = new R2StorageService();
    if (!r2.isConfigured()) {
      res.status(503).json({ error: 'R2 storage not configured (set R2_ACCOUNT_ID / R2_ACCESS_KEY / R2_SECRET_KEY / R2_BUCKET)' });
      return;
    }
    if (!req.file) { res.status(400).json({ error: 'No file uploaded (field name: file)' }); return; }
    if (!ALLOWED_VIDEO_MIME.includes(req.file.mimetype)) {
      res.status(400).json({ error: `Mime ${req.file.mimetype} not allowed; use MP4 (video/mp4)` });
      return;
    }
    const org = resolveOrg(req);
    const budget = await checkBudget(org, req.file.size);
    if (!budget.ok) {
      res.status(413).json({
        error: `Adding this file would exceed the ${Math.round(budget.budgetBytes / 1024 / 1024)} MB shared media budget for this workspace`,
        total_bytes: budget.totalBytes,
        budget_bytes: budget.budgetBytes,
        attempted_bytes: budget.attemptedBytes,
      });
      return;
    }
    const uploadedBy = getSessionUser(req) || 'unknown';
    const key = await r2.uploadVideo(req.file.buffer, req.file.mimetype);
    const id = await new OutreachVideoRepository().addExtra({
      r2_key: key,
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      size_bytes: req.file.size,
      uploaded_by: uploadedBy,
    }, org);
    Logger.info(`outreach extra video added by ${uploadedBy} for org=${org}: ${req.file.originalname} (${req.file.size}B) key=${key} id=${id}`);
    res.json({ ok: true, id: String(id), filename: req.file.originalname, size_bytes: req.file.size, mime_type: req.file.mimetype });
  } catch (err) {
    Logger.error('default-video/extra POST failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /crm/api/outreach/default-video/extra/:id — removes metadata + R2 object
router.delete('/default-video/extra/:id', async (req: Request, res: Response) => {
  try {
    const removedKey = await new OutreachVideoRepository().removeExtra(req.params.id);
    if (removedKey) {
      const r2 = new R2StorageService();
      if (r2.isConfigured()) await r2.deleteObject(removedKey).catch(() => {});
    }
    Logger.info(`outreach extra video removed by ${getSessionUser(req) || 'unknown'}: id=${req.params.id} (removed=${Boolean(removedKey)})`);
    res.json({ ok: true, removed: Boolean(removedKey) });
  } catch (err) {
    Logger.error('default-video/extra/:id DELETE failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /crm/api/outreach/default-media/usage — running total for the
// dashboard's "X / 50 MB used" readout.
router.get('/default-media/usage', async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const usage = await getMediaUsage(org);
    res.json({ total_bytes: usage.totalBytes, budget_bytes: usage.budgetBytes });
  } catch (err) {
    Logger.error('default-media/usage GET failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 3: Append video-route checks to the verification script**

In `scripts/check-outreach-extra-media.ts`, inside the same `try` block used
in Task 2 Step 5 (before the `finally`/server-close), add — guarded on R2
being configured, since a dev machine may not have R2 credentials set:

```ts
    const r2Configured = Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY && process.env.R2_SECRET_KEY && process.env.R2_BUCKET);
    if (r2Configured) {
      const vidBuf = Buffer.from('fake-mp4-bytes-for-testing');
      const vfd = new FormData();
      vfd.append('file', new Blob([vidBuf], { type: 'video/mp4' }), 'route-test.mp4');
      const vAddResp = await fetch(`${base}/default-video/extra?org=${TEST_ORG}`, { method: 'POST', headers: authHeaders, body: vfd });
      check('POST default-video/extra status', vAddResp.status, 200);
      const vAdded = await vAddResp.json();

      const vListResp = await fetch(`${base}/default-video/extra?org=${TEST_ORG}`, { headers: authHeaders });
      const vList = await vListResp.json();
      check('GET default-video/extra lists the added item', vList.some((d: any) => d.id === vAdded.id), true);

      const vDelResp = await fetch(`${base}/default-video/extra/${vAdded.id}`, { method: 'DELETE', headers: authHeaders });
      check('DELETE default-video/extra/:id status', vDelResp.status, 200);
    } else {
      console.log('SKIP  extra-video route checks (R2 env vars not set in this environment)');
    }

    const usageResp2 = await fetch(`${base}/default-media/usage?org=${TEST_ORG}`, { headers: authHeaders });
    check('GET default-media/usage status', usageResp2.status, 200);
    const usageBody = await usageResp2.json();
    check('GET default-media/usage returns budget_bytes', usageBody.budget_bytes, MEDIA_BUDGET_BYTES);
```

- [ ] **Step 4: Run the script and verify all checks PASS**

Run: `npx ts-node scripts/check-outreach-extra-media.ts`
Expected: all `PASS` (video checks `SKIP` cleanly if R2 env vars aren't set
locally — that's fine, they'll run for real against Railway's configured
env, and Task 7's manual end-to-end pass covers real video sends).

- [ ] **Step 5: Commit**

```bash
git add src/api/outreach-routes.ts scripts/check-outreach-extra-media.ts
git commit -m "feat(outreach): add extra-video API routes and shared media usage endpoint"
```

---

## Task 4: `/:id/effective-media` manifest endpoint + agent allowlist

**Files:**
- Modify: `src/api/outreach-routes.ts`
- Modify: `src/api/auth-middleware.ts`
- Modify: `scripts/check-outreach-extra-media.ts`

**Interfaces:**
- Consumes: `OutreachRepository.getById`, `OutreachImagesRepository.{getById,getDefault,listExtras}`,
  `OutreachVideoRepository.{getDefault,listExtras}`, `R2StorageService.generatePresignedGet`.
- Produces: `GET /:id/effective-media` → `Array<{ type: 'image'|'video';
  source: 'custom'|'primary'|'extra'; id: string; filename: string; url:
  string }>`. **Image URLs are server-relative paths** (the worker must
  prefix them with its own `BASE_URL`, same as it already does for
  `EFFECTIVE_IMAGE_URL`); **video URLs are absolute, already-presigned R2
  URLs** (fetch directly, no auth header — same as today's `default-video-url`).

- [ ] **Step 1: Add the manifest endpoint**

Place it directly after the existing `/:id/effective-image` route (reuses
that route for both the custom-image and primary-image cases, since it
already implements exactly that resolution — only extras need a new bytes
route):

```ts
// GET /crm/api/outreach/:id/effective-media — worker-only. Ordered fetch
// manifest for everything to send with this proposal: images (custom
// override if set, else primary + extras) then videos (primary + extras).
// Reuses /:id/effective-image for the single "primary-or-custom" image entry
// (it already implements that exact resolution); only extras get new routes.
router.get('/:id/effective-media', async (req: Request, res: Response) => {
  try {
    const proposalRepo = new OutreachRepository();
    const proposal = await proposalRepo.getById(req.params.id);
    if (!proposal) { res.status(404).json({ error: 'proposal not found' }); return; }

    const org = normalizeOrg(proposal.org_id);
    const imagesRepo = new OutreachImagesRepository();
    const videoRepo = new OutreachVideoRepository();

    type ManifestItem = { type: 'image' | 'video'; source: string; id: string; filename: string; url: string };
    const items: ManifestItem[] = [];

    // Custom override, if it resolves — /:id/effective-image already returns
    // the custom bytes when custom_image_id is set (with its own fallback
    // logging), so we can just check existence here to decide whether to
    // also list primary/extra images.
    let usedCustom = false;
    if (proposal.custom_image_id) {
      const custom = await imagesRepo.getById(proposal.custom_image_id);
      if (custom) {
        items.push({ type: 'image', source: 'custom', id: String(custom._id), filename: custom.filename, url: `/crm/api/outreach/${req.params.id}/effective-image` });
        usedCustom = true;
      }
    }
    if (!usedCustom) {
      const primary = await imagesRepo.getDefault(org);
      if (primary) items.push({ type: 'image', source: 'primary', id: String(primary._id), filename: primary.filename, url: `/crm/api/outreach/${req.params.id}/effective-image` });
      const extras = await imagesRepo.listExtras(org);
      for (const e of extras) {
        items.push({ type: 'image', source: 'extra', id: String(e._id), filename: e.filename, url: `/crm/api/outreach/default-image/extra/${e._id}` });
      }
    }

    const r2 = new R2StorageService();
    if (r2.isConfigured()) {
      const primaryVideo = await videoRepo.getDefault(org);
      if (primaryVideo) {
        const url = await r2.generatePresignedGet(primaryVideo.r2_key);
        items.push({ type: 'video', source: 'primary', id: 'primary', filename: primaryVideo.filename, url });
      }
      const extraVideos = await videoRepo.listExtras(org);
      for (const v of extraVideos) {
        const url = await r2.generatePresignedGet(v.r2_key);
        items.push({ type: 'video', source: 'extra', id: String(v._id), filename: v.filename, url });
      }
    }

    Logger.info(`effective-media[${req.params.id}] org=${org} items=${items.length} types=${items.map((i) => i.type[0]).join('')}`);
    res.json(items);
  } catch (err) {
    Logger.error('effective-media GET failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 2: Add the new agent-allowed paths**

In `src/api/auth-middleware.ts`, add two entries to `AGENT_ALLOWED` (leave
the existing `effective-image` / `default-video-url` entries untouched):

```ts
const AGENT_ALLOWED: Array<{ method: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\/crm\/api\/outreach\/claim$/ },
  { method: 'POST', pattern: /^\/crm\/api\/outreach\/[A-Za-z0-9_-]+\/mark-sent$/ },
  { method: 'POST', pattern: /^\/crm\/api\/outreach\/[A-Za-z0-9_-]+\/mark-failed$/ },
  { method: 'POST', pattern: /^\/crm\/api\/outreach\/worker-heartbeat$/ },
  { method: 'POST', pattern: /^\/crm\/api\/outreach\/worker-alert$/ },
  { method: 'POST', pattern: /^\/crm\/api\/outreach\/report-inbound$/ },
  { method: 'GET',  pattern: /^\/crm\/api\/outreach\/worker-status$/ },
  { method: 'GET',  pattern: /^\/crm\/api\/outreach\/[A-Za-z0-9_-]+\/effective-image$/ },
  { method: 'GET',  pattern: /^\/crm\/api\/outreach\/default-video-url$/ },
  { method: 'GET',  pattern: /^\/crm\/api\/outreach\/[A-Za-z0-9_-]+\/effective-media$/ },
  { method: 'GET',  pattern: /^\/crm\/api\/outreach\/default-image\/extra\/[A-Za-z0-9_-]+$/ },
];
```

(This is the full array, verbatim against the current file — the first nine
entries are unchanged, only the last two are new.)

- [ ] **Step 3: Append manifest checks to the verification script**

In `scripts/check-outreach-extra-media.ts`, insert a proposal, hit the new
route with the AGENT_TOKEN, then delete the test proposal directly via the
raw collection (matching the `scripts/delete-test-proposals.js` /
`scripts/reset-test-proposals.js` convention already in this repo — the
repository layer has no scoped single-proposal delete method). Add near the
top:

```ts
import { ObjectId } from 'mongodb'; // already imported above in Task 1 — don't duplicate
```

Then, inside the same `try` block (after the usage-endpoint check from Task
3), add:

```ts
    if (!process.env.AGENT_TOKEN) process.env.AGENT_TOKEN = 'check-script-agent-token';
    const testProposalId = new ObjectId();
    const proposalsCol = db.getDb().collection('outreach_proposals');
    await proposalsCol.insertOne({
      _id: testProposalId,
      org_id: TEST_ORG,
      generation_id: 'check-script',
      customer_phone: '85500000000',
      customer_name: 'Check Script Test',
      reason_code: null,
      days_since_contact: null,
      follower: null,
      message: 'test',
      reasoning: 'test',
      status: 'pending',
      skipped_reason: null,
      failed_reason: null,
      custom_image_id: null,
      created_at: new Date(),
      approved_at: null,
      approved_by: null,
      sent_at: null,
      lease_expires_at: null,
      model: 'check-script',
    });
    try {
      const manifestResp = await fetch(`${base}/${testProposalId}/effective-media`, {
        headers: { Authorization: `Bearer ${process.env.AGENT_TOKEN}` },
      });
      check('GET :id/effective-media status', manifestResp.status, 200);
      const manifest = await manifestResp.json();
      check('effective-media returns an array', Array.isArray(manifest), true);
      check('effective-media images (if any) come before videos', (() => {
        const firstVideoIdx = manifest.findIndex((m: any) => m.type === 'video');
        const lastImageIdx = manifest.reduce((last: number, m: any, i: number) => (m.type === 'image' ? i : last), -1);
        return firstVideoIdx === -1 || lastImageIdx === -1 || lastImageIdx < firstVideoIdx;
      })(), true);
    } finally {
      await proposalsCol.deleteOne({ _id: testProposalId });
    }
```

(`db` here is the `DatabaseConnection` instance already in scope from
`main()`'s `const db = DatabaseConnection.getInstance();` in Task 1.)

- [ ] **Step 4: Run the script and verify all checks PASS**

Run: `npx ts-node scripts/check-outreach-extra-media.ts`
Expected: all `PASS`, including the manifest ordering check.

- [ ] **Step 5: Commit**

```bash
git add src/api/outreach-routes.ts src/api/auth-middleware.ts scripts/check-outreach-extra-media.ts
git commit -m "feat(outreach): add effective-media manifest endpoint for the worker"
```

---

## Task 5: Worker — send N media items via the manifest

**Files:**
- Modify: `scripts/telegram-worker/worker.ts`

**Interfaces:**
- Consumes: `GET /:id/effective-media` (Task 4).
- Produces: `sendViaMTProto` now builds `mediaPaths` from the manifest
  instead of two separate optional fetches. No change to its return type or
  to `markSent`/`markFailed`/`postAlert` call sites.

- [ ] **Step 1: Replace the two fetch helpers with one manifest fetch**

Remove `fetchEffectiveImage` and `fetchDefaultVideo` (worker.ts:207-281,
`EFFECTIVE_IMAGE_URL`/`DEFAULT_VIDEO_URL` constants at worker.ts:58-59 can
stay defined but unused is untidy — remove them too since nothing references
them after this change). Replace with:

```ts
const EFFECTIVE_MEDIA_URL = (id: string) => `${BASE_URL}/crm/api/outreach/${id}/effective-media`;

interface ManifestItem {
  type: 'image' | 'video';
  source: string;
  id: string;
  filename: string;
  url: string;
}

// Fetch the ordered media manifest for a proposal, then download every item
// and stage it as a temp file. Images are server-relative paths (fetched
// with our bearer token, same auth as everything else); videos are already
// absolute, presigned R2 URLs (fetched with a plain, unauthenticated
// request, same as today's default-video-url flow). Empty manifest is a
// valid text-only send, not an error — matches existing behavior.
async function fetchEffectiveMedia(proposalId: string): Promise<string[]> {
  const resp = await authedFetch(EFFECTIVE_MEDIA_URL(proposalId));
  if (!resp.ok) {
    throw new Error(`effective-media ${resp.status}: ${await resp.text().catch(() => '')}`);
  }
  const manifest = (await resp.json()) as ManifestItem[];
  const paths: string[] = [];
  for (const item of manifest) {
    if (item.type === 'image') {
      const imgResp = await authedFetch(`${BASE_URL}${item.url}`);
      if (!imgResp.ok) throw new Error(`effective-media image fetch ${imgResp.status}: ${item.url}`);
      const buffer = Buffer.from(await imgResp.arrayBuffer());
      const ext = item.filename.split('.').pop() || 'jpg';
      paths.push(await writeTemp(buffer, ext));
    } else {
      const dl = await fetch(item.url); // presigned R2 URL — no auth header
      if (!dl.ok) throw new Error(`effective-media video download failed: HTTP ${dl.status}`);
      const bytes = Buffer.from(await dl.arrayBuffer());
      paths.push(await writeTemp(bytes, 'mp4'));
      console.log(`  video: ${bytes.length}B staged (${item.source})`);
    }
  }
  return paths;
}
```

- [ ] **Step 2: Update `sendViaMTProto` to use it**

The function currently declares its cleanup-tracking locals at the top
(worker.ts:354-356):

```ts
  let importedPeer: Api.User | null = null;
  let imageTmpPath: string | null = null;
  let videoTmpPath: string | null = null;
  try {
```

Replace those three lines with (the `finally` block below needs a variable
that's still in scope on the exception path, so `mediaPaths` must be
declared out here with `let`, not as a `const` inside the `try`):

```ts
  let importedPeer: Api.User | null = null;
  let mediaPaths: string[] = [];
  try {
```

Then find the media-fetch block inside the `try` (worker.ts:374-385):

```ts
    // Image and video are BOTH optional. The message always exists (server
    // falls back to the built-in template), so a send with no media is a plain
    // text message. Media is fetched only after the peer resolves so unreachable
    // numbers don't cost a wasted image fetch / 50MB video download.
    const img = await fetchEffectiveImage(proposalId); // null = none configured for this org
    if (img) console.log(`  image: ${img.kind} ${img.filename} ${img.buffer.length}B`);
    const video = await fetchDefaultVideo();

    // Stage whatever media exists as temp files, image first (legitimacy proof).
    const mediaPaths: string[] = [];
    if (img) { imageTmpPath = await writeTemp(img.buffer, img.filename.split('.').pop() || 'jpg'); mediaPaths.push(imageTmpPath); }
    if (video) { videoTmpPath = video.path; mediaPaths.push(videoTmpPath); }
```

Replace with (assigning the outer `let`, not redeclaring it):

```ts
    // Media (images + videos, primary + extras) is fully optional. The
    // message always exists (server falls back to the built-in template), so
    // a send with no media is a plain text message. Fetched only after the
    // peer resolves so unreachable numbers don't cost wasted downloads.
    mediaPaths = await fetchEffectiveMedia(proposalId);
    if (mediaPaths.length > 0) console.log(`  media: ${mediaPaths.length} item(s) staged`);
```

Finally, update the `finally` block (worker.ts:431-435):

```ts
  } finally {
    if (importedPeer) await deleteImportedContact(client, importedPeer);
    if (imageTmpPath) await fs.promises.unlink(imageTmpPath).catch(() => {});
    if (videoTmpPath) await fs.promises.unlink(videoTmpPath).catch(() => {});
  }
```

to:

```ts
  } finally {
    if (importedPeer) await deleteImportedContact(client, importedPeer);
    for (const p of mediaPaths) {
      await fs.promises.unlink(p).catch(() => {});
    }
  }
```

- [ ] **Step 3: Verify the rest of the function is untouched**

The `mediaPaths.length === 0` text-only branch, the caption/two-bubble
`sendFile` loop, and the `markSent`/`markFailed`/`postAlert` calls at
worker.ts:389-420+ already operate generically on `mediaPaths: string[]` —
confirm by reading the full function after your edit that nothing else
references `img` or `video` (the old variable names). Grep the file for
`\bimg\b|\bvideo\b` outside of comments/logs to confirm no leftover
references.

- [ ] **Step 4: Manual smoke test (no automated worker test exists)**

This can't be verified by the check script (it requires a live gramjs
session + real Telegram send). Defer full verification to Task 7's manual
end-to-end pass. For now, at minimum run `npx tsc --noEmit` from the repo
root to confirm the worker file still type-checks cleanly after the edit.

Run: `npx tsc --noEmit`
Expected: no errors referencing `scripts/telegram-worker/worker.ts`.

- [ ] **Step 5: Commit**

```bash
git add scripts/telegram-worker/worker.ts
git commit -m "feat(outreach-worker): send N media items via the effective-media manifest"
```

---

## Task 6: Dashboard UI — extra-media strips, Add buttons, usage readout

**Files:**
- Modify: `src/reports/templates/crm/outreach.hbs`

**Interfaces:**
- Consumes: `GET/POST/DELETE /default-image/extra`,
  `GET/POST/DELETE /default-video/extra`, `GET /default-media/usage` (Tasks 2-3).

- [ ] **Step 1: Add CSS for the extra-media strip**

After the existing `.image-bar .counter.red { color: var(--red); }` rule
(outreach.hbs:342), add:

```css
  .extra-media-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.5rem;
    align-items: center;
  }
  .extra-media-item {
    position: relative;
    width: 48px;
    height: 48px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--bg);
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.9rem;
  }
  .extra-media-item img { width: 100%; height: 100%; object-fit: cover; }
  .extra-media-item .remove-btn {
    position: absolute;
    top: -6px;
    right: -6px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--red);
    color: #fff;
    border: none;
    cursor: pointer;
    font-size: 0.7rem;
    line-height: 1;
  }
  .media-budget-readout {
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }
```

- [ ] **Step 2: Add the usage readout + Add buttons to the markup**

Replace the two existing cards (outreach.hbs:346-369):

```html
<div class="outreach-wrap">
  <div class="default-image-card">
    <img class="default-image-thumb" id="default-image-thumb" alt="Default brand image" onclick="openLightbox()">
    <div class="default-image-meta">
      <div class="name" id="default-image-name">Loading…</div>
      <div class="sub" id="default-image-sub"></div>
    </div>
    <div class="default-image-actions">
      <input type="file" id="default-image-file" accept="image/jpeg,image/png,image/webp" style="display:none" onchange="uploadDefaultImage(event)">
      <button class="btn btn-primary" onclick="document.getElementById('default-image-file').click()">Replace image</button>
      <button class="btn btn-ghost" id="default-image-remove" style="display:none;color:var(--red);border-color:var(--red)" onclick="removeDefaultImage()">Remove</button>
    </div>
  </div>
  <div class="default-image-card" id="default-video-card">
    <div class="default-image-thumb empty" id="default-video-thumb">🎬</div>
    <div class="default-image-meta">
      <div class="name" id="default-video-name">Loading…</div>
      <div class="sub" id="default-video-sub"></div>
    </div>
    <div class="default-image-actions">
      <input type="file" id="default-video-file" accept="video/mp4" style="display:none" onchange="uploadDefaultVideo(event)">
      <button class="btn btn-primary" onclick="document.getElementById('default-video-file').click()">Replace video</button>
      <button class="btn btn-ghost" id="default-video-remove" style="display:none;color:var(--red);border-color:var(--red)" onclick="removeDefaultVideo()">Remove</button>
    </div>
  </div>
```

with:

```html
<div class="outreach-wrap">
  <div class="media-budget-readout" id="media-budget-readout">Loading media usage…</div>
  <div class="default-image-card">
    <img class="default-image-thumb" id="default-image-thumb" alt="Default brand image" onclick="openLightbox()">
    <div class="default-image-meta">
      <div class="name" id="default-image-name">Loading…</div>
      <div class="sub" id="default-image-sub"></div>
      <div class="extra-media-strip" id="extra-images-strip"></div>
    </div>
    <div class="default-image-actions">
      <input type="file" id="default-image-file" accept="image/jpeg,image/png,image/webp" style="display:none" onchange="uploadDefaultImage(event)">
      <button class="btn btn-primary" onclick="document.getElementById('default-image-file').click()">Replace image</button>
      <button class="btn btn-ghost" id="default-image-remove" style="display:none;color:var(--red);border-color:var(--red)" onclick="removeDefaultImage()">Remove</button>
      <input type="file" id="extra-image-file" accept="image/jpeg,image/png,image/webp" style="display:none" onchange="addExtraImage(event)">
      <button class="btn btn-ghost" id="add-extra-image-btn" onclick="document.getElementById('extra-image-file').click()">+ Add image</button>
    </div>
  </div>
  <div class="default-image-card" id="default-video-card">
    <div class="default-image-thumb empty" id="default-video-thumb">🎬</div>
    <div class="default-image-meta">
      <div class="name" id="default-video-name">Loading…</div>
      <div class="sub" id="default-video-sub"></div>
      <div class="extra-media-strip" id="extra-videos-strip"></div>
    </div>
    <div class="default-image-actions">
      <input type="file" id="default-video-file" accept="video/mp4" style="display:none" onchange="uploadDefaultVideo(event)">
      <button class="btn btn-primary" onclick="document.getElementById('default-video-file').click()">Replace video</button>
      <button class="btn btn-ghost" id="default-video-remove" style="display:none;color:var(--red);border-color:var(--red)" onclick="removeDefaultVideo()">Remove</button>
      <input type="file" id="extra-video-file" accept="video/mp4" style="display:none" onchange="addExtraVideo(event)">
      <button class="btn btn-ghost" id="add-extra-video-btn" onclick="document.getElementById('extra-video-file').click()">+ Add video</button>
    </div>
  </div>
```

- [ ] **Step 3: Add the JS functions**

After the existing `removeDefaultVideo` function (outreach.hbs:550-557), add:

```js
  const EXTRA_IMAGE_URL = API + '/default-image/extra';
  const EXTRA_VIDEO_URL = API + '/default-video/extra';
  const MEDIA_USAGE_URL = API + '/default-media/usage';

  async function refreshMediaUsage() {
    const el = document.getElementById('media-budget-readout');
    try {
      const resp = await fetch(MEDIA_USAGE_URL + '?cb=' + Date.now(), { credentials: 'same-origin' });
      if (!resp.ok) throw new Error('GET default-media/usage ' + resp.status);
      const data = await resp.json();
      const usedMb = (data.total_bytes / (1024 * 1024)).toFixed(1);
      const budgetMb = Math.round(data.budget_bytes / (1024 * 1024));
      el.textContent = usedMb + ' / ' + budgetMb + ' MB used (shared across all default images + videos)';
      const overBudget = data.total_bytes >= data.budget_bytes;
      const addImgBtn = document.getElementById('add-extra-image-btn');
      const addVidBtn = document.getElementById('add-extra-video-btn');
      if (addImgBtn) addImgBtn.disabled = overBudget;
      if (addVidBtn) addVidBtn.disabled = overBudget;
      if (addImgBtn) addImgBtn.title = overBudget ? 'Media budget full — remove something first' : '';
      if (addVidBtn) addVidBtn.title = overBudget ? 'Media budget full — remove something first' : '';
    } catch (err) {
      console.error('refreshMediaUsage', err);
      el.textContent = 'Media usage unavailable';
    }
  }

  async function refreshExtraImages() {
    const strip = document.getElementById('extra-images-strip');
    try {
      const resp = await fetch(EXTRA_IMAGE_URL + '?cb=' + Date.now(), { credentials: 'same-origin' });
      if (!resp.ok) throw new Error('GET default-image/extra ' + resp.status);
      const items = await resp.json();
      strip.innerHTML = items.map((it) =>
        '<div class="extra-media-item">' +
          '<img src="' + EXTRA_IMAGE_URL + '/' + it.id + '?cb=' + Date.now() + '" alt="' + esc(it.filename) + '">' +
          '<button class="remove-btn" onclick="removeExtraImage(\'' + it.id + '\')" title="Remove">×</button>' +
        '</div>'
      ).join('');
    } catch (err) {
      console.error('refreshExtraImages', err);
    }
  }

  async function addExtraImage(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    showToast('Adding image…', 'success');
    try {
      const resp = await fetch(EXTRA_IMAGE_URL, { method: 'POST', credentials: 'same-origin', body: fd });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) { showToast('Image added', 'success'); refreshExtraImages(); refreshMediaUsage(); }
      else { showToast(data.error || ('Add failed: ' + resp.status), 'error'); }
    } catch (err) {
      showToast('Add failed', 'error');
    } finally {
      ev.target.value = '';
    }
  }

  async function removeExtraImage(id) {
    if (!confirm('Remove this extra image?')) return;
    try {
      const resp = await fetch(EXTRA_IMAGE_URL + '/' + id, { method: 'DELETE', credentials: 'same-origin' });
      if (resp.ok) { showToast('Image removed', 'success'); refreshExtraImages(); refreshMediaUsage(); }
      else showToast('Remove failed', 'error');
    } catch { showToast('Remove failed', 'error'); }
  }

  async function refreshExtraVideos() {
    const strip = document.getElementById('extra-videos-strip');
    try {
      const resp = await fetch(EXTRA_VIDEO_URL + '?cb=' + Date.now(), { credentials: 'same-origin' });
      if (!resp.ok) throw new Error('GET default-video/extra ' + resp.status);
      const items = await resp.json();
      strip.innerHTML = items.map((it) => {
        const sizeMb = (Number(it.size_bytes || 0) / (1024 * 1024)).toFixed(1);
        return '<div class="extra-media-item" title="' + esc(it.filename) + ' · ' + sizeMb + ' MB">🎬' +
          '<button class="remove-btn" onclick="removeExtraVideo(\'' + it.id + '\')" title="Remove">×</button>' +
        '</div>';
      }).join('');
    } catch (err) {
      console.error('refreshExtraVideos', err);
    }
  }

  async function addExtraVideo(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    showToast('Adding video… (may take a moment)', 'success');
    try {
      const resp = await fetch(EXTRA_VIDEO_URL, { method: 'POST', credentials: 'same-origin', body: fd });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) { showToast('Video added', 'success'); refreshExtraVideos(); refreshMediaUsage(); }
      else { showToast(data.error || ('Add failed: ' + resp.status), 'error'); }
    } catch (err) {
      showToast('Add failed', 'error');
    } finally {
      ev.target.value = '';
    }
  }

  async function removeExtraVideo(id) {
    if (!confirm('Remove this extra video?')) return;
    try {
      const resp = await fetch(EXTRA_VIDEO_URL + '/' + id, { method: 'DELETE', credentials: 'same-origin' });
      if (resp.ok) { showToast('Video removed', 'success'); refreshExtraVideos(); refreshMediaUsage(); }
      else showToast('Remove failed', 'error');
    } catch { showToast('Remove failed', 'error'); }
  }
```

`esc(...)` is the existing HTML-escaping helper already used elsewhere in
this file (e.g. `outreach.hbs:864`) — confirm it's defined above this point
and reuse it as-is; do not redefine it.

- [ ] **Step 4: Wire the new refreshers into page load and the existing refresh cycle**

Find the page-load calls near the end of the script (outreach.hbs:1084-1085):

```js
  refreshDefaultImage();
  refreshDefaultVideo();
```

Replace with:

```js
  refreshDefaultImage();
  refreshDefaultVideo();
  refreshExtraImages();
  refreshExtraVideos();
  refreshMediaUsage();
```

- [ ] **Step 5: Manual verification in the browser**

This template has no automated test — verify by hand:

1. Run the dev server (`npm run dev` or the project's existing run command).
2. Open `/crm/outreach`, confirm the new "Media usage" readout appears and
   the "+ Add image" / "+ Add video" buttons render next to the existing
   Replace/Remove buttons, for both cards.
3. Add one small test image via "+ Add image" → confirm it appears as a
   thumbnail in the strip with a working ✕ remove button, and the usage
   readout increases.
4. Remove it → confirm the thumbnail disappears and usage readout drops back.
5. Confirm existing "Replace image" / "Remove" / "Replace video" / "Remove"
   still work exactly as before (regression check — this plan must not have
   broken them).

- [ ] **Step 6: Commit**

```bash
git add src/reports/templates/crm/outreach.hbs
git commit -m "feat(outreach): add extra-media UI (Add image / Add video buttons + usage readout)"
```

---

## Task 7: Manual end-to-end verification (real send)

**Files:** none (verification only).

- [ ] **Step 1: Set up a multi-item test send**

On the dev/staging dashboard's Outreach page (a workspace with a *test*
default image already set — do not experiment against the live `company`
production default), add one extra image and (if R2 is configured) one extra
video via the new buttons.

- [ ] **Step 2: Generate and approve one test proposal**

Use the existing "Generate batch" flow (or the existing personal test-phone
scripts referenced in `OUTREACH_MEDIA.md`, e.g. kasing/+85570597666) to
create and approve one proposal for that workspace.

- [ ] **Step 3: Run the worker and confirm the send**

Start `scripts/telegram-worker` against the test session and let it claim
and send the approved proposal. Confirm on the receiving test phone:
- All media items arrive as separate sequential messages, images before
  videos, in the order they were added on the dashboard.
- The caption text rides the first message if the message is ≤1024 chars,
  otherwise arrives as its own trailing message.
- The dashboard proposal card still shows the correct effective-image
  thumbnail/lightbox (unaffected by this change).

- [ ] **Step 4: Confirm text-only still works**

Remove all default media (primary + extras, both types) for the test
workspace, generate + approve one more test proposal, and confirm the worker
sends a plain text message with no error — matching pre-existing behavior
for an org with no media configured.

- [ ] **Step 5: Update `OUTREACH_MEDIA.md`**

Add a short section documenting the new `Add image` / `Add video` buttons,
the shared 50 MB budget (replacing the old per-file 5MB image / 50MB video
caps in the doc's existing "Media" section), and the new
`/:id/effective-media` route in the existing routes table. Follow the
existing doc's style (see `docs/superpowers/specs/2026-08-10-outreach-extra-media-design.md`
for the authoritative behavior to describe).

- [ ] **Step 6: Commit**

```bash
git add OUTREACH_MEDIA.md
git commit -m "docs: document extra-media Add buttons and shared 50MB budget"
```
