# Outreach Media & Failed-Number Lifecycle

This document covers two features that sit on top of the base outreach pipeline
(server drafts → human approves in the CRM → gramjs worker sends):

1. **Media** — the default marketing **image** and **video** sent to every lead.
2. **Failed-number lifecycle** — how numbers that fail (usually privacy-blocked)
   are suppressed, listed, and slowly retried instead of being re-hammered daily.

See `OUTREACH_RUNBOOK.md` for the base pipeline, worker ops, and daily cap/pacing.

---

## 1. Media: image + videos

Every send delivers the default **image** plus this org's **queued videos** (if
any), each as its **own** Telegram message — a mixed photo+video album via
`messages.SendMultiMedia` can fail with `MEDIA_EMPTY` (gramjs), so the worker
sends sequential single-file messages instead (`3f925a0`). The image is
mandatory ("legitimacy proof"); videos are optional marketing content.

- **Image** — bytes stored in MongoDB collection `outreach_images`
  (`OutreachImagesRepository`). JPEG/PNG/WebP, ≤ 5 MB. Managed on the CRM
  Outreach page ("Replace image").
- **Videos** — bytes stored in **Cloudflare R2** (private bucket); only
  *metadata* (the R2 object key + display fields) lives in MongoDB collection
  `outreach_media` (`OutreachVideoRepository`, **one doc per video**, scoped by
  `org_id`). An org may queue up to **5 videos**, MP4 only, whose sizes must
  sum to **≤ 50 MB combined** (not 50 MB each — e.g. 5 + 10 + 20 MB = 35 MB
  fits; adding a 4th that would push the total over 50 MB, or a 6th video at
  all, is rejected with a 400 before anything is uploaded to R2). Managed on
  the CRM Outreach page ("Add video" / per-row "Remove"). Videos are optional —
  with none queued, sends are image-only.

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

### How videos reach the worker

1. CRM upload (`POST /crm/api/outreach/default-video`, developer/manager) →
   rejected with 400 if it would breach the 5-video count or 50 MB combined
   budget (checked before touching R2); otherwise bytes go to R2
   (`outreach-media/default-video-<uuid>.mp4`) and a new metadata doc is
   inserted into `outreach_media`.
2. At send time the worker calls `GET /crm/api/outreach/default-video-url` and
   gets `{ videos: [...] }` — one **short-lived (300 s) presigned GET URL** per
   queued video, oldest-first (signing is local, no creds leave the server).
   An empty `videos` array or `503` (R2 not configured) are both the worker's
   signal to send **image-only**.
3. The worker downloads each presigned URL with a plain `fetch` (no auth
   header), stages it to a temp `.mp4`, and sends each video as its own
   message after the image. `SEND_TIMEOUT_SEC` (default **240 s**) bounds the
   whole send because downloading + uploading up to 50 MB total is slow.

Worker send-mode log strings: `N media (image+video×M)+caption` or
`+two_bubble` when media is present, `text-only` when neither is configured.

### Media routes (`src/api/outreach-routes.ts`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/default-image` | cookie | default image bytes / 404 |
| POST | `/default-image` | cookie | replace (JPEG/PNG/WebP, 5 MB) |
| GET | `/default-video` | cookie | `{ videos, total_bytes, max_bytes, max_count }` for the CRM |
| POST | `/default-video` | cookie | **adds** a video (MP4, ≤50 MB → R2); 400 if it would exceed the 5-count or 50 MB-combined budget; 503 if R2 unconfigured |
| DELETE | `/default-video/:id` | cookie | remove one queued video + its R2 object |
| GET | `/default-video-url` | **agent** | worker-facing `{ videos: [{url, mime_type, size_bytes}] }` array / 503 |
| GET | `/:id/effective-image` | **agent** | worker-facing image bytes (custom-or-default) |

### Agent-role allowlist (9 paths)

The worker's `AGENT_TOKEN` may call exactly these (`src/api/auth-middleware.ts`
`AGENT_ALLOWED`); everything else → 403:

`POST /claim`, `POST /:id/mark-sent`, `POST /:id/mark-failed`,
`POST /worker-heartbeat`, `POST /worker-alert`, `POST /report-inbound`,
`GET /worker-status`, `GET /:id/effective-image`, `GET /default-video-url`.

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
| `outreach_images` | default + custom image **bytes** |
| `outreach_media` | default video **metadata** (R2 key); bytes live in R2 |
| `outreach_suppressions` | phone-level failed/suppressed ledger + retry schedule |
| `outreach_worker_state` | daily claim counter, pause flag, heartbeat |
| `inbound_messages` | inbound replies captured by the worker |
