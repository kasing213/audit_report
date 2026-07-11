# Outreach Image Attachment — Design Spec

> **Point-in-time artifact.** Its "text-only baseline" and "image is mandatory,
> no other media" framing is superseded: outreach now sends an **image + video
> album** (video optional, MP4 ≤ 50 MB, stored in Cloudflare R2). See
> `OUTREACH_MEDIA.md`.

**Status:** Approved (brainstorming) → Ready for implementation plan
**Date:** 2026-05-06
**Author:** kasing + Claude

## Summary

Attach a **default brand image** to every outbound outreach message, with an optional **per-proposal custom image** override. The default is uploaded once via the dashboard and persists in MongoDB; per-proposal customs are uploaded inline while reviewing a pending proposal. The MTProto worker fetches the effective image from the server and sends it via `client.sendFile`, smart-splitting between caption mode and two-bubble mode based on draft length.

## Motivation

Outreach today is text-only. Sales staff want every approved outreach to lead with a polished marketing card (real-estate brand image with phone numbers baked in) so the customer sees a professional first impression even if they skim the caption. Existing pipeline (server drafts → human approves → worker sends) already exists; this design adds the image layer without changing that pipeline shape.

## Architectural decisions

These were locked in during brainstorming:

| # | Decision | Rationale |
|---|---|---|
| D1 | Default image + per-proposal custom override (no library of presets) | One brand at a time; library is YAGNI |
| D2 | Smart-split sending: caption mode if `message.length ≤ 1024`, else image-then-text | Polished single bubble when possible; fall back to two bubbles to respect Telegram caption cap |
| D3 | MongoDB storage (collection `outreach_images`) | Railway filesystem is ephemeral; MongoDB persists and matches existing storage patterns |
| D4 | Image is mandatory on every send (no text-only mode) | "Professional image" implies always-on branding; YAGNI for an escape hatch |
| D5 | Worker fetches image via HTTP from the server, not directly from MongoDB | Worker stays isolated to the HTTP API + `AGENT_TOKEN` (matches existing architecture) |
| D6 | `Generate batch` is gated on a default image existing | Fail-fast — never create proposals the worker cannot send |
| D7 | Auto-approved drafts always use the default (`custom_image_id: null`) | Auto-approve gate doesn't reason about images; manual review path is the only way to attach a custom |

## Data model

### New collection: `outreach_images`

```ts
{
  _id: ObjectId | 'default',  // 'default' is a fixed string id; customs use ObjectId
  filename: string,           // e.g. 'brand.jpg'
  mime_type: string,          // 'image/jpeg' | 'image/png' | 'image/webp'
  size_bytes: number,
  data: Binary,               // BSON Binary, raw bytes
  uploaded_at: Date,
  uploaded_by: string,        // dashboard user (from auth-middleware session)
  kind: 'default' | 'proposal_custom'
}
```

- The default image is the one document with `_id: 'default'`. Replacing the default uses `replaceOne({ _id: 'default' }, doc, { upsert: true })`.
- Per-proposal custom images each get a fresh `ObjectId`.
- Validation rejects files >5MB and any mime type other than `image/jpeg | image/png | image/webp` with HTTP 400/413.

### `outreach_proposals` schema delta

Add one optional field:

```ts
custom_image_id: ObjectId | null  // null = use default; non-null = use the named outreach_images doc
```

Existing proposals are migration-free: missing field is treated as `null`.

### Cleanup (future, not day one)

A janitor job (cron) deletes `outreach_images` docs of `kind: 'proposal_custom'` whose proposal is `sent | skipped | failed` and older than 30 days. The default image is never garbage-collected. **This is flagged as a known follow-up; not built day one.** Revisit when collection size becomes a concern.

## API surface

All endpoints require existing dashboard or worker authentication via `auth-middleware.ts`.

| Method | Path | Auth | Used by | Purpose |
|---|---|---|---|---|
| `GET` | `/crm/api/outreach/default-image` | Cookie or bearer | Dashboard, worker (when no custom) | Returns default image bytes with proper `Content-Type` and an `X-Filename` header |
| `POST` | `/crm/api/outreach/default-image` | Cookie | Dashboard | Multipart upload; replaces the `_id: 'default'` doc. Validates size and mime |
| `POST` | `/crm/api/outreach/:id/image` | Cookie | Dashboard | Multipart upload; creates an `outreach_images` doc and sets `custom_image_id` on the proposal. If a custom already exists for that proposal, the old image doc is deleted first |
| `DELETE` | `/crm/api/outreach/:id/image` | Cookie | Dashboard | Deletes the proposal's custom `outreach_images` doc and sets `custom_image_id: null` |
| `GET` | `/crm/api/outreach/:id/effective-image` | Bearer (worker) | Worker | Returns the bytes the worker should send. If `custom_image_id` set, returns that image; else the default. Sets `Content-Type` and `X-Filename` headers |

The worker only ever reads `effective-image`; the default-vs-custom branch is resolved server-side.

### Resolution timing (subtle but important)

`effective-image` is resolved at **send time**, not at approve time. Implications:

- A proposal approved with `custom_image_id: null` will use whatever the default is **at the moment the worker claims it**, not the default that existed when the human approved.
- A proposal approved with `custom_image_id` set keeps that exact custom image regardless of later default changes (the custom doc is referenced by id and only deleted by the user via `DELETE /:id/image` or by the future janitor).
- This is intentional: the more common operation is "replace the default" (e.g., new monthly promo card) and we want all queued-but-not-yet-sent proposals to pick it up automatically. If you ever need approve-time snapshot semantics, that's a future change — not in scope.

## Worker changes (`scripts/telegram-worker/worker.ts`)

After a successful claim, before sending:

1. `GET /crm/api/outreach/:id/effective-image` with `Authorization: Bearer <AGENT_TOKEN>`.
2. Read the response into a Buffer; read `X-Filename` header (fall back to `brand.jpg`).
3. Build a `CustomFile(filename, buffer.length, '', buffer)` from `telegram/client/uploads`.
4. Smart-split:
   - If `proposal.message.length <= 1024`: `client.sendFile(peer, { file, caption: proposal.message })` — single bubble.
   - Else: `client.sendFile(peer, { file })` then `client.sendMessage(peer, { message: proposal.message })` — two bubbles.
5. Existing `markSent` / `markFailed` flow stays the same.

The worker never caches the image in memory — at 15 sends/day the bandwidth is trivial and statelessness is worth more than the optimization.

## Failure modes

Every failure path logs at the layer it happens (server endpoints log uploads/replaces; worker logs fetches and send results) so the Failed tab can be triaged from logs alone.

| Failure | Layer | Behavior |
|---|---|---|
| Upload >5MB | Server | HTTP 413; dashboard shows error toast |
| Upload wrong mime | Server | HTTP 400; dashboard shows error toast |
| Worker `effective-image` fetch fails (network/5xx) | Worker | `markFailed(id, 'image fetch failed: <status>')`, continue loop |
| `effective-image` returns 404 because default doesn't exist | Worker | `markFailed(id, 'no default image')` + `postAlert('image-missing', ...)`. Server-side, `Generate batch` is also gated to prevent this state |
| `client.sendFile` fails (PHONE_NOT_OCCUPIED, USER_NOT_FOUND, etc.) | Worker | Existing error mapping (`sendViaMTProto` already handles these) |
| Two-bubble mode: `sendFile` ok but `sendMessage` fails | Worker | `markFailed(id, 'image sent, text failed: <reason>')` — visible on Failed tab so a human can decide whether to follow up manually |
| Two-bubble mode partial success | Worker | The customer has the image but no caption. The proposal is `failed`, not `sent`, so it doesn't get counted in daily quota and a human sees it on the Failed tab |
| Default missing at start of `Generate batch` | Server | HTTP 409; dashboard shows the setup banner instead of generating drafts |

## UI changes

All on `src/reports/templates/crm/outreach.hbs` and the matching server route(s).

### 1. Default brand image card (top of page)

A new card above the worker bar:

```
┌────────────────────────────────────────┐
│ ┌──────┐                               │
│ │ thumb│  Default brand image          │
│ │      │  brand.jpg · 184 KB           │
│ │      │  [Replace image]              │
│ └──────┘                               │
└────────────────────────────────────────┘
```

- Thumbnail (~80px) shows the current default. Clicking it opens a lightbox at full size.
- "Replace image" → file picker → `POST /default-image`.
- If no default exists yet, the card shows a red setup banner ("Upload a default brand image to enable outreach") and the `Generate batch` button on the same page is disabled.

### 2. Per-proposal editing bar

Between the textarea and the action buttons on each proposal card:

```
┌─────────────────────────────────────────────────────────┐
│ Customer Name                          [pending badge]  │
│ +85512345678 · 47d stale · F                            │
│ ┌─────────────────────────────────────────────────┐     │
│ │ <textarea: proposal-message>                    │     │
│ └─────────────────────────────────────────────────┘     │
│ ┌────┐                                                  │
│ │ 📷 │ Default image  [📎 Replace] [↺ Use default]  830 / 1024│
│ └────┘                                                  │
│ [Save draft edit] [Approve] [Skip]                      │
│ Show reasoning            14:02 · approved by …         │
└─────────────────────────────────────────────────────────┘
```

- Thumbnail (~40px) reflects the effective image: default unless `custom_image_id` is set on the proposal.
- Label flips between "Default image" and "Custom image".
- `📎 Replace` → file picker → `POST /:id/image`. Thumbnail and label refresh.
- `↺ Use default` → only visible when a custom is set → `DELETE /:id/image`. Thumbnail and label revert.
- Counter `830 / 1024`:
  - **Green** when `length ≤ 1024` → caption mode (one Telegram bubble).
  - **Yellow** when `1024 < length ≤ 4096` → two-bubble mode (image, then separate text). Tooltip: *"Will send as image then separate text — over caption limit."*
  - **Red** when `length > 4096` → impossible to send. Save and Approve are disabled until shortened.
- Counter updates live as the textarea is edited.
- The bar is read-only when the proposal status is anything other than `pending` (mirrors existing textarea `[readonly]` behavior).

### 3. Mobile wrap

The editing bar wraps on narrow screens in this order:
1. `[thumb] [label]`
2. `[Replace] [Use default]`
3. `counter`

Uses existing dark-theme tokens (`var(--surface)`, `var(--accent)`, `var(--yellow)`, `var(--red)`). No new fonts.

## Logging requirements

All logs go through the existing `Logger` utility.

| Event | Level | Fields |
|---|---|---|
| Default image uploaded/replaced | info | `uploaded_by`, `filename`, `size_bytes`, `mime_type` |
| Custom image uploaded for proposal | info | `proposal_id`, `image_id`, `uploaded_by`, `filename`, `size_bytes` |
| Custom image removed from proposal | info | `proposal_id`, `prior_image_id` |
| `effective-image` request | info (worker side) | `proposal_id`, `image_id_resolved`, `kind: 'default' | 'proposal_custom'` |
| Send mode chosen | info | `proposal_id`, `mode: 'caption' | 'two_bubble'`, `message_length` |
| `sendFile` failure | error | `proposal_id`, `phone`, `error_message` |
| `sendMessage` failure after `sendFile` ok | error | `proposal_id`, `phone`, `error_message`, `note: 'two-bubble partial'` |
| Image fetch failure | error | `proposal_id`, `http_status`, `body_snippet` |
| Default missing at send time | error | `proposal_id`, `worker_id` (also triggers `postAlert`) |

## Out of scope (explicit YAGNI)

- Drag-drop image upload (file picker only)
- In-browser image cropping/editing
- A library/preset picker
- Versioning of past defaults
- Pre-send preview modal showing the Telegram bubble look
- Day-one janitor for old custom images (flagged as follow-up)
- Image attachment in the auto-approve path (auto-approved drafts always use default)
- Pure text-only sends (mandatory image; no escape hatch)

## Testing strategy

- **Unit-level:**
  - `OutreachImageRepository.replaceDefault` upserts under `_id: 'default'`.
  - `setCustomImage` deletes prior custom doc before writing the new one.
  - `removeCustomImage` clears the proposal field and deletes the image doc.
  - Send-mode chooser: lengths 0, 1024, 1025, 4096, 4097 → `caption | caption | two_bubble | two_bubble | refuse`.
- **Integration:**
  - Upload default → GET `/default-image` returns it with correct content-type.
  - Upload custom → GET `/:id/effective-image` returns custom; DELETE → returns default again.
  - Generate batch with no default present → 409.
- **End-to-end (manual, one customer):**
  - Approve a proposal in caption mode (≤1024) → confirm one bubble received with image and caption on the test phone (kasing/+85570597666).
  - Approve a proposal in two-bubble mode (>1024) → confirm image bubble and text bubble received in order.
  - Replace default mid-flight → confirm next send uses new image.
  - Set custom on one proposal, leave another with default → confirm both go out correctly.

## Implementation order

The implementation plan (next step, via `writing-plans`) will sequence roughly as:

1. `outreach_images` collection + repository + validation
2. Default-image API endpoints + dashboard card UI
3. Per-proposal custom-image API endpoints + editing bar UI
4. `effective-image` endpoint
5. Worker changes (fetch + smart-split + new logging)
6. `Generate batch` gating + setup banner
7. Counter logic + caption/two-bubble visual states
8. Manual end-to-end test on test phones (kasing/+85570597666 and Chan kasing/+85511228226)
