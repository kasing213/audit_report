# Outreach runbook

How to diagnose and operate the outreach pipeline when something goes wrong.
Setup for the worker itself is in `scripts/telegram-worker/README.md`; this
document is for the **operator** AFTER setup is done.

## Architecture in 30 seconds

| Component | Where it runs | Auth | What it does |
|---|---|---|---|
| Bot (Telegraf) | Railway | `TELEGRAM_BOT_TOKEN` | Receives bulk reports, posts audit messages, serves `/crm` |
| Outreach agent | Railway (cron tick) | DB only | Drafts proposals via OpenAI, writes to `outreach_proposals` |
| Outreach worker(s) | Your laptop | `TELEGRAM_API_ID/HASH` + StringSession | **One per org** (company / personal). Claims that org's approved proposals, sends MTProto messages, posts heartbeats. See [Multi-org](#multi-org-company--personal). |

The flow is:

```
bulk Telegram report
   → bot saves leads_events
       → (cron 09:00 KL) OutreachScheduler.runScan()
           → openai-drafter writes outreach_proposals (status=pending OR approved)
               → human approves on /crm/outreach (or auto-approve gate passed)
                   → worker poll claims → sendMessage → mark-sent
```

## Multi-org (Company / Personal)

Outreach runs as **two separate workspaces under one dashboard**: `company`
(default) and `personal`, each with its **own Telegram sending number**, daily
caps, branding, imported customers, and failed-numbers list. Sales-group
ingestion and the daily/monthly reports are **always Company** — `personal` is
import-and-outreach only. A single `org_id` string threads through everything
(registry: `src/outreach/orgs.ts`; request resolver: `src/outreach/org-context.ts`).

### How the active org is chosen

- **Dashboard:** the **Company | Personal** toggle top-right next to Logout sets
  an `outreach_org` cookie (`GET /crm/set-org?org=…`). Every `/crm` page and API
  call follows the cookie — **no second password**, available to any logged-in
  user. (Not the developer/manager token gate — it's a plain workspace toggle.)
- **Worker:** each worker declares its org via the `ORG_ID` env, sent as the
  `X-Org-Id` header on every request.
- `company` also matches legacy **null**, so all pre-split data is Company
  automatically.

### What's scoped per org

| Thing | Per-org key / field |
|---|---|
| Proposals / leads / suppressions | `org_id` field (absent ⇒ company) |
| Worker state (caps, heartbeat, pause) | doc `_id` = `company` \| `personal` |
| Default message / image / video | doc `_id` = `default:company` \| `default:personal` |
| Daily caps | 15 **delivered** + 40 **attempt** ceiling, counted per org |

### Two workers, two sessions

`ecosystem.config.js` defines **two pm2 apps**, each pinned to its own session
file + `ORG_ID`:

| App | Session file | Org |
|---|---|---|
| `outreach-worker-company` | `telegram-string-session.txt` | company |
| `outreach-worker-personal` | `telegram-string-session-personal.txt` | personal |

Bootstrap each number's session ONCE — the `STRING_SESSION_PATH` decides which
file gets written:

```powershell
# company number
$env:STRING_SESSION_PATH="./telegram-string-session.txt"; npm run login
# personal (new) number
$env:STRING_SESSION_PATH="./telegram-string-session-personal.txt"; npm run login
```

> ⚠️ **Session-path gotcha — this bit us once.** `npm run login` writes to
> `STRING_SESSION_PATH`, or if that's unset, the **default**
> `./telegram-string-session.txt` (the *company* file). A bare `npm run login`
> (or an `$env:` line that didn't take) will **overwrite the company session**
> with whatever number you log in as. Always run `$env:…; npm run login` as ONE
> line and **confirm the `Session saved to …` output names the file you meant.**
> Recovery if you clobbered company: `mv` the just-written file to the personal
> path, then re-login the **company** number back into
> `./telegram-string-session.txt`.

Start both (replacing the old single `outreach-worker` app):

```powershell
pm2 delete outreach-worker            # remove the old single-app process if present
pm2 start scripts/telegram-worker/ecosystem.config.js
pm2 save
```

### Adding / setting up the personal workspace

1. Bootstrap the personal session (above), with its own `STRING_SESSION_PATH`.
2. (Optional) Dashboard → switch to **Personal** → set a default image, message,
   and/or video. **All three are optional** — with none set, the worker sends
   **text-only** using the built-in template. Image and video are added for
   legitimacy/marketing, not required to send.
3. Import personal customers via **Import → Outreach** while Personal is active;
   the import is stamped `org_id=personal` and never mixes with company.
4. Start `outreach-worker-personal` and confirm its log says `org=personal`.

### One-time migration (already applied 2026-07-17)

`scripts/backfill-org-company.js` stamps all pre-split data `company`, migrates
the singleton worker-state → `company`, re-keys the `default` branding docs →
`default:company`, and drops the legacy `phone_unique` suppression index.
**Must run together with the deploy** — the new code reads `default:company`, so
running it long before or after the deploy leaves company branding unreadable in
the gap. Dry-run by default; `--confirm` to apply; idempotent.

### Verify multi-org is healthy

- `node scripts/check-outreach-worker.js` → lists **two** per-org state blocks
  (company + personal) with independent caps.
- `curl -H "Authorization: Bearer $AGENT_TOKEN" $BASE/crm/api/outreach/worker-status`
  → JSON includes `"org"` and `"attempt_cap"` (their presence proves the new
  code is live; the `X-Org-Id` header / `outreach_org` cookie selects the org).
- Each worker's startup log shows `org=company` or `org=personal`.

### Known limitations (scoped out deliberately)

- Editing a customer (`PATCH`/`DELETE /crm/api/customers/:phone`) acts by phone
  **across** orgs — low risk since the two lists are different people.
- Automated backup-retries (privacy failures) run **Company-only**; Personal is
  manual re-import.
- `inbound_messages` docs aren't org-tagged (the inbound customer *lookup* is).

## Payment Tracker (third workspace)

Payment Tracker drafts reminders from receivables in `ar_tracker.ar_state`, not
from stale sales leads. It has its own source credential, template, approval
mode, Telegram session, PM2 process, and daily cap. Company and Personal are
unchanged by it — the sales scanner iterates `SALES_OUTREACH_ORGS`, which does
not include Payment Tracker.

The worker runs on the **Mac**, not the Windows machine. Provisioning steps
(session creation, pm2, boot persistence, and the macOS-specific gotchas) are in
[PAYMENT_TRACKER_MAC_SETUP.md](PAYMENT_TRACKER_MAC_SETUP.md).

### Rollout order (do not skip ahead)

Each step gates the next. Nothing sends until the last one.

```powershell
# 1. Verify the source credential BEFORE enabling anything.
#    exit 0 = ready, exit 1 = credential/schema blocker, exit 2 = data not ready.
npx ts-node scripts/check-payment-tracker-source.ts

# 2. Create the payment Telegram session (only this filename, never overwrites).
cd scripts/telegram-worker
npm run login:payment

# 3. Start the payment worker. Server-side state ships PAUSED, so it polls and
#    sends nothing until you resume it in the dashboard.
pm2 start ecosystem.payment-tracker.config.js

# To stop it again:
pm2 stop outreach-worker-payment-tracker
```

Then, in the dashboard (Outreach → Payment Tracker workspace):

4. Save the reminder wording and click **Approve wording**. Scanning and Auto
   are both blocked until wording is approved.
5. Set `PAYMENT_TRACKER_SCAN_ENABLED=true` and restart the server to enable the
   daily 10:00 (Cambodia) scan. Use **Scan now** to draft on demand first.
6. Review the drafts, then resume the worker to send Manual-approved reminders.
7. Enable **Auto** only after stakeholder acceptance. Auto cannot be switched on
   without currently-approved wording.

### Hard rules

- `PAYMENT_TRACKER_DATABASE_URL` must be an Atlas custom role granting only
  `find` and `listIndexes` on `ar_tracker.ar_state`. The built-in database-wide
  `read` role is broader than required and the check script rejects it. **The
  Payment-Tracker system's own `atlasAdmin` URI must never be used here.**
- audit-sales never writes to `ar_state`, and never creates an index on it. An
  unsuitable index is reported to the Payment Tracker administrator as a
  blocker, not repaired from this side.
- Company/Personal PM2 commands are unchanged. `ecosystem.config.js` still
  defines exactly two apps; the payment worker lives in its own file so a
  routine restart of the sales workers cannot start it by accident.
- A reminder is never sent on scan-time data. Every claim re-reads the source
  and re-verifies; if the receivable was paid, the proposal is cancelled instead.

### When Payment Tracker is not sending

Check in this order — each has a distinct cause:

| Symptom | Cause |
|---|---|
| `Scanning disabled` in Source verification | `PAYMENT_TRACKER_SCAN_ENABLED` is not `true` |
| Scan refuses with wording error | wording is unsaved, or was edited and not re-approved |
| Drafts exist but nothing sends | Payment worker state is paused (it ships paused) |
| Claim returns `daily_cap_reached` | `PAYMENT_TRACKER_DAILY_CAP` reached for the Cambodia day |
| Proposal stuck with `verification_state: blocked` | source unreadable/unknown status; retries after 10 min |
| Proposal `cancelled` with `all_referenced_ars_ineligible` | the customer paid before the reminder went out — working as intended |

## Worker process management (pm2)

The laptop worker runs under **pm2** (`scripts/telegram-worker/ecosystem.config.js`).
Since the multi-org split there are **two apps** — `outreach-worker-company` and
`outreach-worker-personal` (see [Multi-org](#multi-org-company--personal)). pm2
restarts each on crash (`autorestart: true`). The daily pre-run bounce
(default **08:30 local**, 30 minutes ahead of the 09:00 Cambodia outreach
scan, and before the watchdog window opens at 09:00 so the restart's heartbeat
gap can't raise a false `worker-offline` alert) is handled by the worker
itself, not pm2's `cron_restart`: it polls
`GET /crm/api/outreach/schedule-settings` every 5 min and exits cleanly once
the configured `bounce_time` arrives, and pm2's `autorestart` brings it back
up fresh. A sleeping laptop simply misses the bounce; the worker still serves
the batch because it polls `/claim` every 60s regardless of process age.

The bounce/scan/active-hours times are editable live from the dashboard's
Schedule panel (`/crm/outreach`) — no file edit or `pm2` command needed;
changes apply on the worker's next 5-min poll and reschedule the Railway-side
crons immediately. `node scripts/check-bounce-precedes-scan.js` asserts the
*defaults* still keep the bounce before the scan.

**`active_start_hour`/`active_end_hour` IS the sending window** (fixed
2026-08-05 — this note originally said the opposite, which was true at the
time and turned out to be a real incident: a proposal left `approved` from a
prior day sat unclaimed until the delivery/claim counters reset at UTC
midnight — 07:00 Cambodia, well before any sane scan/active-hours time — and
the worker sent it the instant that happened, regardless of `scan_time`).
`POST /crm/api/outreach/claim` now checks `active_start_hour`/`active_end_hour`
before reserving a claim slot; outside that window it returns
`{ proposal: null, outside_active_hours: true }` and the worker just waits,
no attempt-budget spent. Set `active_start_hour` to roughly match `scan_time`
(or earlier) so the two stay coherent — `scan_time` controls when the batch
is *drafted*, `active_start_hour`/`active_end_hour` controls when the worker
is *allowed to send*, and there's no enforced coupling between them.

Commands below use `<app>` — substitute either app name, or omit it to act on
all.

| Command | What it does |
|---|---|
| `pm2 list` | Are both apps `online`? `↺` column = restart count. |
| `pm2 logs <app>` | Tail worker output (heartbeats, sends, errors). |
| `pm2 restart <app>` | Manual bounce. |
| `pm2 stop <app>` | Stop (stays registered; won't auto-restart). |
| `pm2 start scripts/telegram-worker/ecosystem.config.js` | (Re)start both from the ecosystem file. |
| `pm2 save` | Persist the process list so it survives a daemon restart. |
| `pm2 resurrect` | Restore the saved process list (used at boot). |

If you change `ecosystem.config.js`, run `pm2 delete` + `pm2 start` (structural
changes need a full recreate, not `--update-env`) and `pm2 save` again.

### Boot persistence (Windows) — logon Scheduled Task

pm2's native `pm2 startup` fails on Windows (`Init system not found`). Boot
recovery is a **logon Scheduled Task** named `pm2-resurrect-outreach` that runs
`pm2 resurrect` as the user. After a reboot, the worker comes back **a few
seconds after you log in** (not before — fine for a personal laptop; the
server-side watchdog covers any work-hours gap). The task action is:

```powershell
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `
  "$env:PM2_HOME='C:\Users\SH Computer\.pm2'; & 'C:\Users\SH Computer\AppData\Roaming\npm\pm2.cmd' resurrect"
```

Verify it: `Get-ScheduledTaskInfo -TaskName 'pm2-resurrect-outreach'` →
`LastTaskResult` should be `0`.

> ⚠️ **Do NOT also run pm2 as a Windows Service (pm2-installer).** pm2 on Windows
> uses ONE global control pipe `\\.\pipe\rpc.sock` that is **not** namespaced by
> `PM2_HOME`. A LocalService pm2 service grabs that pipe at boot and blocks the
> user-level pm2 with `connect EPERM //./pipe/rpc.sock` — the logon task then
> fails (`LastTaskResult=1`) and the worker never resurrects. The two cannot
> coexist. If pm2-installer was ever set up, disable it (admin PowerShell):
>
> ```powershell
> Stop-Service pm2.exe -Force
> Set-Service  -Name pm2.exe -StartupType Disabled
> [Environment]::SetEnvironmentVariable('PM2_HOME', $null, 'Machine')
> ```
>
> Then the pipe is free, `pm2 resurrect` works, and the worker heartbeats again
> (confirm with `railway run node scripts/check-outreach-worker.js` →
> `heartbeat_age_minutes` ~0).

## Server-side offline watchdog

`HeartbeatWatchdogScheduler` (`src/scheduler/heartbeat-watchdog-scheduler.ts`)
runs on Railway and DMs the operator a `worker-offline` alert when the heartbeat
goes stale — the safety net for when pm2/the laptop itself is down (a laptop-side
check can't detect its own death). Reuses `notifyOutreachFailure` + its 30-min
per-kind throttle, so at most one ping per half hour.

| Env var | Default | Effect |
|---|---|---|
| `HEARTBEAT_WATCHDOG_ENABLED` | unset (off) | Must be `true` to register the watchdog cron |
| `WORKER_ALERT_CHAT_ID` | falls back to `AUDIT_CHAT_ID` | DM target (operator's numeric Telegram id; DM the bot once first) |
| `HEARTBEAT_STALE_MINUTES` | `15` | Heartbeat age that counts as "offline" |
| `HEARTBEAT_WATCHDOG_CRON` | `*/5 9-21 * * *` | Tick cadence + work-hours window (the `9-21` range never ticks overnight, so a sleeping laptop never false-alarms) |
| `TIMEZONE` | `Asia/Phnom_Penh` | Timezone the watchdog cron runs in |

To test: during the day, `pm2 stop outreach-worker`, wait > `HEARTBEAT_STALE_MINUTES`,
expect one DM; `pm2 start outreach-worker` to clear.

## Collection names (easy to confuse)

| Collection | Holds | Used by |
|---|---|---|
| `leads_events` | Customer interaction history (one row per touch) | `/crm`, bulk-confirm, scheduler |
| `daily_summaries` | Per-day counter aggregates from bulk reports | reports |
| `outreach_proposals` | Drafted outreach messages with `status` lifecycle (+ `org_id`) | outreach agent, worker, `/crm/outreach` |
| `outreach_worker_state` | **Per-org** (`_id: company\|personal`) heartbeat / caps / pause flag | worker, dashboard badge |
| `outreach_settings` | **Per-org** (`_id: default:<org>`) default outreach message | `/crm/outreach`, worker text |
| `outreach_images` | Per-org default (`_id: default:<org>`) + per-proposal custom image **bytes** | worker (`effective-image`), `/crm/outreach` |
| `outreach_media` | **Per-org, one doc per queued video** (up to 5, 50 MB combined) **metadata** (R2 key); bytes live in Cloudflare R2 | worker (`default-video-url`), `/crm/outreach` |
| `outreach_suppressions` | Phone-level failed/suppressed ledger (+ `org_id`, unique per org+phone) | mark-failed, retry scan, `/crm/failed-numbers` |
| `inbound_messages` | Customer replies received by the worker | inbound alerts |
| `audit_logs` | Bot action history | audit trail |

⚠️ The collection is `outreach_proposals`, NOT `outreach_drafts`. (Easy mistake — burned us once.)

**Media & failed-number lifecycle:** R2 env vars (`R2_ACCOUNT_ID`/`R2_ACCESS_KEY`/`R2_SECRET_KEY`/`R2_BUCKET`), the image+video album send, the 503 "R2 not configured" fallback, suppression classification, the 60d×3 backup retry (`OUTREACH_RETRY_ENABLED`, `OUTREACH_RETRY_DAILY_BUDGET`), and the `/crm/failed-numbers` page are all documented in **`OUTREACH_MEDIA.md`**.

## When something is broken

### 1. Outreach not sending

```
railway run node scripts/check-outreach-worker.js
```

Read the `outreach_worker_state` block(s) — **one per org** — at the top of the output:

| Field | Healthy value | If wrong → |
|---|---|---|
| `heartbeat_age_minutes` | 0–5 | That org's worker is dead (closed laptop, crashed, expired session). `pm2 restart outreach-worker-<org>` (see Worker process management). |
| `worker_id` | `HOSTNAME-PID` of the machine you expect | Wrong host is running the worker. Stop the other one. |
| `paused` | `false` | Someone hit Pause on `/crm/outreach` for that org. Click Resume. |
| `last_error` | `null` | Read it — names the failing layer. |
| `deliveries_today` | `< 15` (delivery cap) | Cap reached → org done for the day; resets UTC midnight. |
| `claims_today` | `< 40` (attempt ceiling) | Hit before 15 delivered ⇒ a batch of unreachable numbers; check `/crm/failed-numbers`. |
| `claims_today_day` | Today's UTC date | Stale → counters reset on next claim. |

Then `outreach_proposals counts by status`:

- `pending` — waiting for human approval at `/crm/outreach`.
- `approved` — claimable; worker will pick up next cycle.
- `in_flight` — worker has claimed but not yet marked. Lease expires in ~5min and it'll be re-claimable.
- `sent` — done.
- `failed` — terminal. `failed_reason` says why. Re-generate to retry.
- `skipped` — agent refused to draft (recent contact, blocklist, etc.).

### 2. Drafts are skipping pending and auto-sending

The auto-approve gate is on. Check the env var:

```
railway variables --kv | findstr OUTREACH_AUTO_APPROVE
```

To force every draft through human review:

```
railway variables --set OUTREACH_AUTO_APPROVE=false
```

The gate code (`src/outreach/auto-approve-gate.ts`) has 10 explicit rules.
Borderline drafts already fall back to `pending` anyway — auto-approve only
fires when ALL rules pass.

### 3. Worker is running, but new drafts aren't appearing

The outreach scheduler is cron-driven, not write-driven.

| Env var | Default | Effect |
|---|---|---|
| `OUTREACH_AUTO_SCAN` | unset (treated as off) | If not `true`, the cron is registered but never fires |
| `OUTREACH_CRON` | `0 9 * * *` | When the scan runs |
| `TIMEZONE` | `Asia/Phnom_Penh` | Cron timezone. Cambodia local — `0 9 * * *` means 09:00 in Phnom Penh. Setting this to a UTC+8 zone silently moves every scan an hour early. |
| `OUTREACH_STALE_DAYS` | `45` | A customer must be silent this long to qualify |
| `OUTREACH_DAILY_DRAFT_BUDGET` | `30` | Cap on drafts per UTC day |
| `OUTREACH_BATCH_LIMIT` | `10` | Cap per scan tick |

To force a scan now without waiting for the cron:

```
POST /crm/api/outreach/scheduler/run-once
```

Logs in as `dashboard` and posts a summary to the audit chat. Does nothing if
there are no eligible customers in `leads_events`.

### 4. Bulk-confirm reports a save but `/crm` doesn't show the record

Grep Railway logs for `[bulk-confirm]` and `[crm-customers]`. Both tags emit
on every relevant call:

| Tag pattern | What it tells you |
|---|---|
| `[bulk-confirm] preview created token=…` | Preview message rendered, awaiting tap |
| `[bulk-confirm] action fired token=…` | Telegram delivered the callback to the bot |
| `[bulk-confirm] tap received … pendingSize=N` | Handler entered; map state visible |
| `[bulk-confirm] NOT in pending map` | Server restarted between preview and confirm |
| `[bulk-confirm] saveLeadEvents returned 2 ids: …` | Save succeeded |
| `[bulk-confirm] FAILED` | Save threw; stack trace follows |
| `[crm-customers] returned=N sample=[…] hasMarker=…` | What the customers API actually returned |

If `[bulk-confirm] SUCCESS` fires but `[crm-customers] hasMarker=false`, the
bug is in the view path, not the save path.

### 5. Worker is throwing a Telegram-side error

Common cases:

| Error | Cause | Fix |
|---|---|---|
| `PHONE_NOT_OCCUPIED` / `USER_NOT_FOUND` | Phone isn't a Telegram account | Proposal flips to `failed`. Re-generate if it should be a different draft. |
| `AUTH_KEY_UNREGISTERED` / `SESSION_REVOKED` | StringSession invalidated (logged out from another device, account password changed) | Re-run `npm run login` in `scripts/telegram-worker/` |
| `chat did not load via tgaddr …` (with `screenshot=…`) | Legacy Playwright error \| | Worker is on old code. `git pull` to get the gramjs rewrite. |

### 6. High "contact import deferred by Telegram" rate (not a privacy block)

**Symptom:** most attempts fail with `contact import deferred by Telegram`
(NOT `phone number not on Telegram (or hidden by privacy)`). The two look
similar in the logs but mean completely different things:

| Failure | What it actually means |
|---|---|
| `phone number not on Telegram (or hidden by privacy)` | The target number really isn't reachable — not on Telegram, or has privacy settings hiding it from contact import. Permanent, correctly skipped. |
| `contact import deferred by Telegram` | Telegram's server is throttling **our session's** `ImportContacts` RPC specifically — nothing to do with the target number. A number that gets "deferred" from the bot can often be messaged fine from the same account through the actual Telegram app. |

**Root cause found 2026-08-05:** the Mac Mini migration (2026-08-01) put the
worker on a freshly-created Telegram authorization instead of continuing the
established one. Confirmed via `account.GetAuthorizations()` — Telegram scopes
trust to the specific auth key (session), not the account's age. The old,
trusted auth key (created 2026-07-17, the one with a month of clean 15/15 and
zero deferrals — see July pm2 logs) sat idle as a separate `Windows_NT` entry
in Settings → Devices, while a brand-new `Darwin` entry did all the post-
migration sending and got progressively MORE throttled over the following
days (54% deferred cumulative since the move → 85% by day 5).

**Fix:** recover the OLD session file (it's still on whatever machine hosted
the worker before — the Windows laptop, in this case, at
`scripts/telegram-worker/telegram-string-session*.txt`) and swap it back in.
**Don't trust file timestamps to tell old vs. new sessions apart** — a
straight `scp`/copy can preserve or reset mtime depending on flags, and mtime
tells you nothing about which Telegram auth key is inside the file anyway.
Verify for real:

1. Stop the pm2 worker for that org (releases the live connection so the
   check isn't just seeing the still-running old state).
2. Connect with the candidate file and call `account.GetAuthorizations()` —
   look at `dateCreated` on the entry marked `current: true`. That's the auth
   key's actual age, regardless of which machine/device label the connection
   reports (device label is always based on whatever machine is *currently*
   connecting, not something baked into the session).
3. Only then restart pm2 with that file in place.

If the old session isn't recoverable, there's no known way to transplant
trust onto a fresh auth key — the account's overall age doesn't help;
Telegram trusts sessions, not accounts. Worth trying: cut `ImportContacts`
volume/frequency on the new session for a few days before concluding it's
permanently stuck, since the actual throttle mechanics are undocumented.

### 7. Switching a worker to a different Telegram account

Each org has its own session file — re-login **the one for that org** and be
careful with the path (see the session-path gotcha under
[Multi-org](#multi-org-company--personal)):

1. `pm2 stop outreach-worker-<org>`.
2. Re-create just that org's session — the `STRING_SESSION_PATH` decides the file:
   ```powershell
   # company:  $env:STRING_SESSION_PATH="./telegram-string-session.txt"; npm run login
   # personal: $env:STRING_SESSION_PATH="./telegram-string-session-personal.txt"; npm run login
   ```
   Confirm the `Session saved to …` line names the file you intended, then enter
   the new phone.
3. `pm2 start outreach-worker-<org>` (or restart both from the ecosystem file).

The `TELEGRAM_API_ID`/`HASH` in `.env` don't change — they're app-level, not
account-level, and are shared by both workers.

### 8. Cross-tenant video leak (fixed 2026-08-12)

**Symptom:** `outreach-worker-company` sent a real customer a video that
actually belonged to `personal` (identifiable in `~/.pm2/logs/outreach-worker-
company-out.log` by a video byte-size that never appeared in company's send
history before, but matches a size in `outreach-worker-personal`'s log).

**Root cause, two layers:**

1. The `GET /default-video-url` route (now `GET /:id/effective-video-url`)
   resolved which org's videos to return from the *calling worker's own*
   `X-Org-Id` header/`ORG_ID` env, instead of from the org of the specific
   proposal being messaged — unlike `effective-image`, which was always
   proposal-scoped. Fixed: the route now takes a proposal id and derives org
   via `normalizeOrg(proposal.org_id)`, same as `effective-image`.
2. `orgMatch()` (`src/outreach/orgs.ts`) gives `company` (the default org) a
   null-fallback for legacy pre-multi-org data. A leftover `outreach_media`
   doc from before the 2026-08-11 multi-video migration
   (`scripts/backfill-multi-video.js`) still had no `org_id`, so it matched
   `company`'s query and got queued alongside company's real video.

**Fix:** both the route/worker code (above) and the underlying data were
corrected; see `check-outreach-media-org-ids.js` in
[Diagnostic scripts](#diagnostic-scripts) — run it after any future
`outreach_media` migration to confirm no doc is missing `org_id`.

## Diagnostic scripts

All under `scripts/`. Read-only unless noted. Always invoke through Railway so
they hit production Mongo:

```
railway run node scripts/<name>.js
```

| Script | Purpose | Destructive? |
|---|---|---|
| `check-bulk-confirm.js` | Look up bulk-confirm test phones in `leads_events`, plus latest bulk-telegram audits | no |
| `check-outreach-worker.js` | Per-org worker heartbeats + draft counts by status + queued/in_flight rows | no |
| `telegram-worker/whoami-session.js` | Print which Telegram account a session file is (`node whoami-session.js ./telegram-string-session.txt` → phone + name). Run from `scripts/telegram-worker`. **Stop that org's worker first** so you don't double-connect the same session. | no |
| `check-070.js` | Proposals/leads/suppression for the 070597666 test number, plus proposal counts by (org, status) | no |
| `preview-pending-outreach.js` | Full message body of every claimable proposal — read before starting the worker if you're unsure what's queued | no |
| `query-bulk.js` | Older snapshot script for the deprecated `bulk-paste` model. Mostly historical. | no |
| `check-outreach-media-org-ids.js` | Verifies every `outreach_media` doc has an `org_id` set. Run this after any `outreach_media` migration/backfill, and if a worker ever sends the wrong org's video — see the 2026-08-12 cross-tenant video leak below. | no |

## Destructive one-shots (NOT committed)

These live on dev laptops only. Each requires `--confirm` to do anything.

| Script | Effect |
|---|---|
| `clear-leads-events.js` | `deleteMany({})` on `leads_events`. Wipes all customer history. |
| `delete-test-proposals.js` | Removes specific test phones from `outreach_proposals`. |

Use only when you genuinely want to start from zero.

## Operational gotchas

- **Sending to your own phone routes to Saved Messages** in Telegram. Test
  with a phone other than the worker account's, or look in Saved Messages.
- **Session files live next to `worker.ts`** — `telegram-string-session.txt`
  (company) and `telegram-string-session-personal.txt` (personal). Treat each
  like a password — a full account login. Don't commit, don't paste in chat.
  Mind the **session-path gotcha** under [Multi-org](#multi-org-company--personal):
  a bare `npm run login` overwrites the *company* file.
- **Only one cap, enforced server-side per org**: **15 delivered**
  (`deliveries_today` on that org's `outreach_worker_state` doc). As of
  2026-08 there's no separate attempt ceiling — `claims_today` is tracked but
  purely observational. Unreachable numbers (privacy/deferred/invalid) burn
  neither a hard-capped resource; the worker keeps claiming until 15 land.
  Running two copies of the same org's worker doesn't double its cap — they
  race for the same slot.
- **`failed` is terminal, for every failure kind** — privacy, invalid, AND
  deferred (see [gotcha 6](#6-high-contact-import-deferred-by-telegram-rate-not-a-privacy-block)).
  No auto-retry anywhere in the system. Re-generate to draft again. The
  worker does pause itself for a while (not cap, not suppress) after 5
  consecutive deferrals in a row — `DEFERRAL_BACKOFF_THRESHOLD`/`_MIN` env
  vars — pure pacing so it isn't hammering Telegram's throttle every poll.
- **Pause is server-side.** Click Pause on `/crm/outreach`; the worker reads
  the flag every iteration. No restart needed.
- **Media sends go as SEPARATE messages, not an album.** Image and video (then
  the text, if it's over 1024 chars) are sent one at a time. A mixed photo+video
  album via `messages.SendMultiMedia` throws `MEDIA_EMPTY` in gramjs, so the
  worker never groups them. With no image/video set, it's a plain text send. If
  a send fails with `MEDIA_EMPTY`, the worker is on old code — restart it.
- **A session file is identified by ACCOUNT, not filename.** `npm run login`
  writes whatever number you enter to `STRING_SESSION_PATH`, so a mislabeled
  login can silently put the personal account in the company file (or vice
  versa) and the worker runs the wrong number. After ANY login mishap, verify
  with `whoami-session.js` (stop that worker first) — the account name/phone is
  the source of truth, not the filename.
- **Creating a proposal writes to the ACTIVE org.** Import → Outreach (and
  generation) tag the new lead/proposal with whatever org the dashboard toggle
  is on (the `outreach_org` cookie). If a personal import "shows up in company,"
  the toggle wasn't on Personal when you imported — switch first, then import.
