# Outreach Media & Failed-Number Lifecycle

This document covers two features that sit on top of the base outreach pipeline
(server drafts → human approves in the CRM → gramjs worker sends):

1. **Media** — the default marketing **image** and **video** sent to every lead.
2. **Failed-number lifecycle** — how numbers that fail (usually privacy-blocked)
   are suppressed, listed, and slowly retried instead of being re-hammered daily.

See `OUTREACH_RUNBOOK.md` for the base pipeline, worker ops, and daily cap/pacing.

---

## 1. Media: image + video, one or more of each

Every send delivers all configured media as sequential messages (not a true
Telegram album/media-group — a mixed photo+video `SendMultiMedia` album was
found unreliable, so each item is sent as its own `sendFile` call), images
first, then videos. All media is optional — a workspace with none configured
sends text-only. Each workspace has:

- **One primary default image + any number of extra images** — bytes stored
  in MongoDB collection `outreach_images` (`OutreachImagesRepository`).
  JPEG/PNG/WebP. Managed on the CRM Outreach page ("Replace image" for the
  primary, "+ Add image" for extras — each extra has its own remove button).
- **One primary default video + any number of extra videos** — bytes stored
  in **Cloudflare R2** (private bucket); only *metadata* (the R2 object key +
  display fields) lives in MongoDB collection `outreach_media`
  (`OutreachVideoRepository`). **MP4 only.** Managed on the CRM Outreach page
  ("Replace video" for the primary, "+ Add video" for extras).
- **Shared 50 MB budget** — not a per-file cap. Every upload (primary replace
  or extra add, image or video) is checked against the combined size of all
  default media (primary + extras, both types) for that workspace; an upload
  that would push the total over 50 MB is rejected with HTTP 413. The
  dashboard shows a running "`X / 50 MB used`" readout. See
  `src/outreach/outreach-media-budget.ts` and
  `docs/superpowers/specs/2026-08-10-outreach-extra-media-design.md`.
- A proposal's per-lead **custom image override** (one custom image,
  uploaded inline while reviewing a pending proposal — see
  `docs/superpowers/specs/2026-05-06-outreach-image-attachment-design.md`)
  still replaces only the image side: it swaps out the whole image list for
  that one custom image, while default videos still send.

### R2 configuration (server only)

The API server holds the R2 credentials; the worker never does. Set these four
env vars on the server (Railway):

| Env var | What it is |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account ID (builds the endpoint `https://<id>.r2.cloudflarestorage.com`) |
| `R2_ACCESS_KEY` | R2 API token Access Key ID (Object Read & Write) |
| `R2_SECRET_KEY` | R2 API token Secret Access Key |
| `R2_BUCKET` | Bucket name |

Create the keys in Cloudflare → **R2 → Manage R2 API Tokens → Create API Token**
with **Object Read & Write** scoped to the bucket. The bucket stays **private** —
no public access, no custom domain, no CORS needed.

> **Jurisdiction gotcha:** `R2StorageService` uses the standard endpoint
> `https://<account_id>.r2.cloudflarestorage.com`. An **EU-jurisdiction** bucket
> uses `...eu.r2.cloudflarestorage.com` and will fail signing — use a standard
> bucket.

### How media reaches the worker

1. CRM uploads (`POST /crm/api/outreach/default-video` for the primary,
   `POST /crm/api/outreach/default-video/extra` for extras) → bytes go to R2
   (`outreach-media/default-video-<uuid>.mp4`), metadata upserted into
   `outreach_media`. Images (`POST /default-image`, `POST /default-image/extra`)
   go straight into MongoDB (`outreach_images`).
2. At send time the worker calls `GET /crm/api/outreach/:id/effective-media`
   once and gets back an **ordered manifest** — images first (custom override
   if the proposal has one, else primary + extras, in add-order), then videos
   (primary + extras, in add-order). Video entries already carry a
   **short-lived (300 s) presigned GET URL** (signing happens server-side
   while building the manifest — no R2 creds ever reach the worker). An empty
   manifest is a valid text-only send, not an error.
3. For each manifest item the worker fetches it (images with its bearer
   token via a server-relative path; videos via the presigned URL, no auth
   header) and stages it to a temp file, then sends every item as its own
   sequential `sendFile` call — images before videos, add-order within each
   group. `SEND_TIMEOUT_SEC` (default **240 s**) bounds the whole send since
   a large video download + upload is slow.

Worker log line: `media: N item(s) staged`, followed by one `sendFile` per
item; caption rides the first item if the message is ≤ 1024 chars, else it
follows as its own message after all media.

### Media routes (`src/api/outreach-routes.ts`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/default-image` | cookie | primary default image bytes / 404 |
| POST | `/default-image` | cookie | replace the primary (JPEG/PNG/WebP; shared 50 MB budget) |
| DELETE | `/default-image` | cookie | clear the primary |
| GET | `/default-image/extra` | cookie | list this org's extra images |
| POST | `/default-image/extra` | cookie | add an extra image (does not touch the primary) |
| GET | `/default-image/extra/:id` | cookie, **agent** | bytes for one extra image, org-scoped |
| DELETE | `/default-image/extra/:id` | cookie | remove one extra image, org-scoped |
| GET | `/default-video` | cookie | primary default video metadata / 404 |
| POST | `/default-video` | cookie | replace the primary (MP4 → R2; shared 50 MB budget); 503 if R2 unconfigured |
| DELETE | `/default-video` | cookie | clear the primary + delete its R2 object |
| GET | `/default-video/extra` | cookie | list this org's extra videos |
| POST | `/default-video/extra` | cookie | add an extra video (R2 + metadata; does not touch the primary) |
| DELETE | `/default-video/extra/:id` | cookie | remove one extra video + its R2 object, org-scoped |
| GET | `/default-media/usage` | cookie | `{ total_bytes, budget_bytes }` for the dashboard's usage readout |
| GET | `/default-video-url` | **agent** | legacy presigned-URL endpoint; kept but no longer called by the worker (superseded by `effective-media`) |
| GET | `/:id/effective-image` | cookie, **agent** | dashboard thumbnails/lightbox + legacy worker path (custom-or-default single image) |
| GET | `/:id/effective-media` | **agent** | worker-facing ordered fetch manifest (images then videos) — see above |

### Agent-role allowlist (11 paths)

The worker's `AGENT_TOKEN` may call exactly these (`src/api/auth-middleware.ts`
`AGENT_ALLOWED`); everything else → 403:

`POST /claim`, `POST /:id/mark-sent`, `POST /:id/mark-failed`,
`POST /worker-heartbeat`, `POST /worker-alert`, `POST /report-inbound`,
`GET /worker-status`, `GET /:id/effective-image`, `GET /default-video-url`,
`GET /:id/effective-media`, `GET /default-image/extra/:id`.

---

## 2. Failed-number lifecycle (suppression + backup retry)

**Problem:** a number that fails to send (typically *"not on Telegram / hidden by
privacy"*) was re-selected into every subsequent batch and re-sent forever,
because (a) a failure writes no `leads_events` doc so the phone never ages out of
the "stale" candidate pool, and (b) the per-phone dedup gate ignored `failed`
proposals. It also refunded the daily cap on failure, so unreachable numbers
burned unlimited throughput.

**Fix:** a phone-level ledger, MongoDB collection **`outreach_suppressions`**
(`OutreachSuppressionRepository`), one doc per international phone (unique).

### Failure classification (`classifyFailure`)

| Kind | Reason substrings | Behavior |
|---|---|---|
| **privacy** | `not on telegram`, `hidden by privacy`, `PHONE_NOT_OCCUPIED`, `USER_NOT_FOUND`, `PEER_ID_INVALID` | Suppressed + **retried every 60 days, up to 3 times**, then `exhausted`. |
| **invalid** | `phone number invalid (permanent)` / `PHONE_NUMBER_INVALID` | Suppressed **forever**, never retried. |
| **transient** | `mtproto exception`, `image fetch failed`, `lease expired`, `text failed`, `unspecified` | Recorded for visibility only; **does not suppress** — the phone re-enters normal generation. |

Kind priority on upsert: `invalid > privacy > transient` (a later transient
error never downgrades a privacy/invalid doc).

### What changed in the pipeline

- **`mark-failed`** records the failure in the ledger and now refunds the daily
  cap **only for transient** failures (privacy/invalid consumed a real Telegram
  round-trip → they count against the cap).
- **`mark-sent`** calls `resolve(phone)` — a previously-failed number that
  finally delivers leaves the suppression list.
- **Candidate generation** (`selectCandidates`) drops suppressed phones *before*
  slicing the batch, so a batch is never wasted on known failures.
- **Worker** distinguishes `PHONE_NUMBER_INVALID` (→ `invalid`) from
  privacy/not-on-Telegram (→ `privacy`).

### Backup-retry scan (fully automatic)

`OutreachScheduler.runRetryScan()` runs on the daily cron (after the normal
draft scan):

1. `listForRetry(now, budget)` → privacy suppressions whose 60-day cooldown has
   elapsed, oldest first, capped by `OUTREACH_RETRY_DAILY_BUDGET`.
2. `generateBatch({ phones, bypassSuppression:true, autoApprove:true })` mints
   fresh proposals **created directly as `approved`** (`approved_by='auto-retry'`)
   so the worker sends them under the normal daily cap + 60–180 s pacing — no
   human step.
3. For each phone actually re-minted, `bumpRetry` increments the counter and
   reschedules +60 d, or marks `exhausted` at 3. Phones that couldn't be minted
   (already have a live proposal, or no customer record) are `deferRetry`'d so
   they don't monopolize the next day's budget.

`bumpRetry` is the sole owner of `retries_used` / `next_retry_at`; on a repeat
failure `recordFailure` only refreshes the last-failed metadata (no double-count).

### New env vars

| Env var | Default | Meaning |
|---|---|---|
| `OUTREACH_RETRY_ENABLED` | *(off)* | `true` to enable the backup-retry scan |
| `OUTREACH_RETRY_DAILY_BUDGET` | `10` | Max privacy retries re-queued per day |

### Failed-numbers CRM page

`/crm/failed-numbers` (nav: **Failed Numbers**) lists the ledger, deduped by
phone. Columns: phone (t.me link), name, follower, kind, status, retries `n/3`,
next-retry date, last-failed date/reason. Filter by status/kind + search.
**Nothing is ever deleted** — exhausted and resolved rows stay listed.
Data API: `GET /crm/api/outreach/failed-numbers` (`?kind,status,follower,q,limit,offset`).

### Backfill

Seed the ledger from existing failed proposals once (idempotent, staggers
privacy retry dates so a cohort doesn't clump on one day):

```
npx ts-node scripts/backfill-suppressions.ts
```

---

## Collections summary

| Collection | Holds |
|---|---|
| `outreach_proposals` | per-send proposals (pending/approved/in_flight/sent/skipped/failed) |
| `outreach_images` | primary default (`kind:'default'`) + extra (`kind:'extra'`) + per-proposal custom (`kind:'proposal_custom'`) image **bytes** |
| `outreach_media` | primary default + extra video **metadata** (R2 key); bytes live in R2 |
| `outreach_suppressions` | phone-level failed/suppressed ledger + retry schedule |
| `outreach_worker_state` | daily claim counter, pause flag, heartbeat |
| `inbound_messages` | inbound replies captured by the worker |
