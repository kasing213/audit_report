# Outreach Extra Media (Add Image / Add Video) — Design Spec

**Status:** Approved (brainstorming) → Ready for implementation plan
**Date:** 2026-08-10
**Author:** kasing + Claude

## Summary

Add the ability to attach **more than one** default image and **more than one**
default video to outreach sends, without changing anything about how the
existing single "default image" / "default video" slots work today. Two new
buttons — **"Add image"** and **"Add video"** — let a workspace append extra
media alongside the existing primary default; each extra is independently
removable. The only new constraint is a **shared 50 MB byte budget** across
all default media (primary + extras, both types) for the workspace — there is
no cap on item *count*.

## Motivation

Today `POST /default-image` and `POST /default-video` each *replace* a single
fixed document per org (`_id: 'default'`). There is no code path to have more
than one default image or more than one default video — not because of an
enforced limit, but because the data model only has room for one document.
The user wants to send more than one image and/or more than one video per
outreach album (e.g. two marketing clips) while keeping today's primary
image/video behavior completely intact.

## Non-goals (explicit YAGNI, decided during brainstorming)

- No unification of images and videos into one collection/list — they stay
  two separate storage backends (image bytes in MongoDB, video bytes in R2 +
  Mongo metadata), exactly as today.
- No reordering UI — media sends in a fixed order: all images (primary, then
  extras in the order they were added), then all videos (primary, then
  extras in add-order).
- No change to the per-proposal custom-image override mechanism beyond what's
  described below — it stays a single image, not a list.
- No per-item count cap (not "max 5", not "max 10") — only the 50 MB shared
  byte budget gates additions.
- No migration required — primary image/video storage is untouched; extras
  are purely additive new documents.
- No change to the existing `Generate batch` gate — it still requires a
  primary default image to exist for the org before drafts can be created.
  Extras don't affect this check either way.

## Data model

### `outreach_images` — new document shape for extras

Existing primary doc (`_id: 'default'`, unchanged) stays as-is. Extras get
their own `ObjectId` and a `kind` discriminator:

```ts
{
  _id: ObjectId,               // NOT 'default' — one per extra
  org: string,
  kind: 'extra',
  filename: string,
  mime_type: 'image/jpeg' | 'image/png' | 'image/webp',
  size_bytes: number,
  data: Binary,
  uploaded_at: Date,
  uploaded_by: string,
}
```

Add-order = `_id` order (MongoDB `ObjectId`s are chronological by
construction), so no separate `order` field is needed.

### `outreach_media` (video) — new document shape for extras

Same pattern: existing primary doc (`_id: 'default'`) unchanged; extras get
their own `ObjectId`:

```ts
{
  _id: ObjectId,
  org: string,
  kind: 'extra',
  r2_key: string,
  filename: string,
  mime_type: 'video/mp4',
  size_bytes: number,
  uploaded_at: Date,
  uploaded_by: string,
}
```

### Shared 50 MB budget

Computed on demand (not stored): `sum(size_bytes)` across the primary image
doc (if any) + primary video doc (if any) + all `kind:'extra'` image docs +
all `kind:'extra'` video docs, for that org. Every upload (primary replace
*or* extra add) checks `current_total + new_file_size <= 50 * 1024 * 1024`
before writing; rejects with HTTP 413 and a message stating current usage and
the attempted file's size otherwise.

The old separate per-file caps (`MAX_IMAGE_BYTES` = 5 MB, `MAX_VIDEO_BYTES` =
50 MB) are removed — the shared budget supersedes them (a single file can
never exceed 50 MB anyway, since that's the whole budget).

Mime-type allowlists (`image/jpeg|png|webp`, `video/mp4`) are unchanged — this
is a format check, unrelated to the size tweak.

## API surface (`src/api/outreach-routes.ts`)

Existing endpoints — **unchanged behavior**:

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/default-image` | Primary image bytes / 404 |
| `POST` | `/default-image` | Replaces primary image doc |
| `DELETE` | `/default-image` | Clears primary image doc |
| `GET` | `/default-video` | Primary video metadata / 404 |
| `POST` | `/default-video` | Replaces primary video (R2 + metadata) |
| `DELETE` | `/default-video` | Clears primary video + R2 object |

New endpoints:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/default-image/extra` | Cookie | List extra image metadata (id, filename, size, uploaded_at/by), add-order |
| `POST` | `/default-image/extra` | Cookie | Multipart upload; inserts a new `kind:'extra'` doc. 413 if over shared budget |
| `GET` | `/default-image/extra/:id` | Cookie or agent | Bytes for one extra image (thumbnail + worker fetch) |
| `DELETE` | `/default-image/extra/:id` | Cookie | Removes one extra image doc |
| `GET` | `/default-video/extra` | Cookie | List extra video metadata, add-order |
| `POST` | `/default-video/extra` | Cookie | Multipart upload → R2 + new `kind:'extra'` metadata doc. 413 if over shared budget |
| `DELETE` | `/default-video/extra/:id` | Cookie | Removes one extra video doc + its R2 object |
| `GET` | `/default-media/usage` | Cookie | `{ total_bytes, budget_bytes: 52428800 }` for the running-total UI display |
| `GET` | `/:id/effective-media` | agent | **Replaces** `/:id/effective-image` + `/default-video-url` for worker use. See below. |

`/:id/effective-media` (agent-role) returns the full ordered fetch manifest
for a proposal:

```ts
[
  { type: 'image', source: 'custom' | 'primary' | 'extra', id: string, url: string },
  // ...more images
  { type: 'video', source: 'primary' | 'extra', id: string, url: string },
  // ...more videos
]
```

- If the proposal has `custom_image_id` set: the image group is `[{ type:
  'image', source: 'custom', ... }]` only — no primary/extra images. Video
  group is unaffected (primary + extras still included).
- Otherwise: image group = primary (if set) + all extras, in add-order.
- Video group: primary (if set) + all extras, in add-order, always following
  the image group — same as today.
- Image group empty at manifest time (primary default image was removed
  after the proposal was generated/approved, since resolution happens at
  send time — the same timing caveat as the original image-attachment
  design) → **not** treated as text-only. This is the existing "default
  missing at send time" failure mode: the worker should treat an empty image
  group as a hard failure (see Worker changes / Error handling), matching
  today's behavior, since the `Generate batch` gate assumes an image will be
  available. Video group is still allowed to be empty (video is, and stays,
  optional).
- `url` for image entries points at a bytes endpoint the worker fetches with
  its bearer token (`/default-image`, `/default-image/extra/:id`, or a
  proposal-scoped custom-image bytes endpoint). `url` for video entries is a
  short-lived presigned R2 GET URL, exactly like today's
  `/default-video-url`, generated per video id.

### Agent-role allowlist (`src/api/auth-middleware.ts`)

Replace `GET /:id/effective-image` and `GET /default-video-url` in
`AGENT_ALLOWED` with `GET /:id/effective-media`, plus add `GET
/default-image`, `GET /default-image/extra/:id` (bytes, needed for the
manifest's image URLs to be fetchable by the worker's bearer token).

## Worker changes (`scripts/telegram-worker/worker.ts`)

Replace the current "fetch effective-image, fetch default-video-url, send
`[image, video]`" with:

1. `GET /:id/effective-media` → ordered manifest.
2. If the manifest has zero `type:'image'` entries → `markFailed(id, 'no
   default image')` + `postAlert('image-missing', ...)`, matching today's
   behavior for a default removed between approval and send. Do not attempt
   to send.
3. For each entry: `type:'image'` → `GET url` with `Authorization: Bearer
   <AGENT_TOKEN>`, read bytes. `type:'video'` → plain `fetch(url)` (presigned,
   no auth header), stage to temp `.mp4`.
4. Build `CustomFile` per item (matches existing pattern).
5. Smart-split as today: if `message.length <= 1024`, `sendFile(peer, {
   file: files, caption: message })` (multi-file album with caption on first
   item); else send the album first, then a separate `sendMessage` with the
   full text.
6. `markSent` / `markFailed` flow unchanged otherwise.

## UI changes (`src/reports/templates/crm/outreach.hbs`)

- Existing "Default brand image" card: unchanged (thumb, name/size, Replace,
  Remove). Below it, a small thumbnail strip of extra images, each with a ✕,
  plus an **"Add image"** button (file picker, same mime accept list as
  Replace).
- Existing "Default video" card: unchanged (thumb icon, name/size, Replace,
  Remove). Same treatment: extra-videos strip + **"Add video"** button.
- A small running-total readout near the top of the media section, e.g. `31.2
  / 50 MB used`, sourced from `GET /default-media/usage`, refreshed after
  every add/remove. Add buttons disable (with a tooltip stating current
  usage) once a pick would exceed the budget — actual enforcement is
  server-side; the disable is a UX nicety, not the source of truth.

## Error handling

| Failure | Layer | Behavior |
|---|---|---|
| Add would exceed 50 MB shared budget | Server | HTTP 413 with `{ error, total_bytes, budget_bytes, attempted_bytes }`; dashboard toast shows the numbers |
| Wrong mime type on extra upload | Server | HTTP 400, same message pattern as today's primary uploads |
| Worker `effective-media` fetch fails | Worker | `markFailed(id, 'media manifest fetch failed: <status>')` |
| Manifest has zero images (default removed after approval) | Worker | `markFailed(id, 'no default image')` + `postAlert('image-missing', ...)` — same as today's timing-drift failure mode |
| Worker fails to fetch one manifest item (image or video) | Worker | `markFailed(id, 'media fetch failed: <type> <id>: <status>')` — whole send aborts rather than partially sending, so retries are clean |
| `sendFile` (album) fails | Worker | Existing error mapping unchanged |
| Two-bubble mode: album ok but `sendMessage` fails | Worker | Existing `'image sent, text failed: <reason>'` pattern, generalized to `'media sent, text failed: <reason>'` |

## Testing strategy

- **Unit:**
  - Extra-image/extra-video repository `add()` inserts with fresh `ObjectId`
    and `kind:'extra'`, doesn't touch the primary doc.
  - Shared-budget calculator sums primary + extras correctly across both
    collections for a given org.
  - Budget check rejects at the boundary (`total + new > 50MB` → 413; `total
    + new == 50MB` → allowed).
  - `effective-media` manifest ordering: images (primary, extras) then videos
    (primary, extras); custom-image case swaps out the whole image group.
- **Integration:**
  - Add two extra images + one extra video → `GET /default-image/extra` and
    `GET /default-video/extra` list them in add-order.
  - Remove one extra → budget total drops accordingly, list updates.
  - Upload that would exceed budget → 413, no doc written.
  - `effective-media` for a proposal with `custom_image_id` set → only the
    custom image in the image group, videos still present.
- **End-to-end (manual, one test proposal):**
  - Primary image + 1 extra image + primary video + 1 extra video → confirm
    a single Telegram album of 4 items arrives in image-image-video-video
    order, followed/preceded by caption per the length rule.
  - Remove an extra mid-flight, regenerate/approve a new proposal → confirm
    it reflects the updated set.

## Implementation order

1. Extra-image and extra-video repository methods (`add`, `list`, `remove`,
   `sumBytesForOrg`) alongside the existing primary methods.
2. Shared-budget check wired into both primary replace and extra add paths.
3. New API endpoints (list/add/remove extras, usage endpoint).
4. `/:id/effective-media` manifest endpoint; retire
   `/:id/effective-image` + `/default-video-url` from the agent allowlist in
   favor of it.
5. Worker: manifest fetch + multi-item send + empty-image-group failure
   handling.
6. Dashboard UI: extra-media strips, Add buttons, running-total readout.
7. Manual end-to-end test on test phones.
