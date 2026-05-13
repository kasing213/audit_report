# Outreach runbook

How to diagnose and operate the outreach pipeline when something goes wrong.
Setup for the worker itself is in `scripts/telegram-worker/README.md`; this
document is for the **operator** AFTER setup is done.

## Architecture in 30 seconds

| Component | Where it runs | Auth | What it does |
|---|---|---|---|
| Bot (Telegraf) | Railway | `TELEGRAM_BOT_TOKEN` | Receives bulk reports, posts audit messages, serves `/crm` |
| Outreach agent | Railway (cron tick) | DB only | Drafts proposals via OpenAI, writes to `outreach_proposals` |
| Outreach worker | Your laptop | `TELEGRAM_API_ID/HASH` + StringSession | Claims approved proposals, sends MTProto messages, posts heartbeats |

The flow is:

```
bulk Telegram report
   → bot saves leads_events
       → (cron 09:00 KL) OutreachScheduler.runScan()
           → openai-drafter writes outreach_proposals (status=pending OR approved)
               → human approves on /crm/outreach (or auto-approve gate passed)
                   → worker poll claims → sendMessage → mark-sent
```

## Collection names (easy to confuse)

| Collection | Holds | Used by |
|---|---|---|
| `leads_events` | Customer interaction history (one row per touch) | `/crm`, bulk-confirm, scheduler |
| `daily_summaries` | Per-day counter aggregates from bulk reports | reports |
| `outreach_proposals` | Drafted outreach messages with `status` lifecycle | outreach agent, worker, `/crm/outreach` |
| `outreach_worker_state` | Singleton heartbeat / counters / pause flag | worker, dashboard badge |
| `inbound_messages` | Customer replies received by the worker | inbound alerts |
| `audit_logs` | Bot action history | audit trail |

⚠️ The collection is `outreach_proposals`, NOT `outreach_drafts`. (Easy mistake — burned us once.)

## When something is broken

### 1. Outreach not sending

```
railway run node scripts/check-outreach-worker.js
```

Read the `outreach_worker_state` singleton at the top of the output:

| Field | Healthy value | If wrong → |
|---|---|---|
| `heartbeat_age_minutes` | 0–5 | Worker is dead (closed laptop, crashed, expired session). Restart on laptop. |
| `worker_id` | `HOSTNAME-PID` of the machine you expect | Wrong host is running the worker. Stop the other one. |
| `paused` | `false` | Someone hit Pause on `/crm/outreach`. Click Resume. |
| `last_error` | `null` | Read it — names the failing layer. |
| `sent_today` | Within `DAILY_CAP` | Cap reached → wait for UTC midnight. |
| `claims_today_day` | Today's UTC date | Stale → counter will reset on next claim. |

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
| `TIMEZONE` | `Asia/Kuala_Lumpur` | Cron timezone |
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

### 6. Switching the worker to a different Telegram account

1. Ctrl-C the worker.
2. Delete `scripts/telegram-worker/telegram-string-session.txt`.
3. `npm run login` and enter the new phone.
4. `npm start`.

The `TELEGRAM_API_ID`/`HASH` in `.env` don't change — they're app-level, not
account-level.

## Diagnostic scripts

All under `scripts/`. Read-only unless noted. Always invoke through Railway so
they hit production Mongo:

```
railway run node scripts/<name>.js
```

| Script | Purpose | Destructive? |
|---|---|---|
| `check-bulk-confirm.js` | Look up bulk-confirm test phones in `leads_events`, plus latest bulk-telegram audits | no |
| `check-outreach-worker.js` | Worker heartbeat + draft counts by status + queued/in_flight rows | no |
| `preview-pending-outreach.js` | Full message body of every claimable proposal — read before starting the worker if you're unsure what's queued | no |
| `query-bulk.js` | Older snapshot script for the deprecated `bulk-paste` model. Mostly historical. | no |

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
- **The session file lives next to `worker.ts`** by default
  (`./telegram-string-session.txt`). Treat it like a password — it's a full
  account login. Don't commit, don't paste in chat.
- **DAILY_CAP is enforced server-side too** (the `claims_today` counter on
  `outreach_worker_state`), so running two worker copies doesn't double the
  cap. They'll just race for the same claim slot.
- **`failed` is terminal.** No silent retries. Re-generate to draft again.
- **Pause is server-side.** Click Pause on `/crm/outreach`; the worker reads
  the flag every iteration. No restart needed.
