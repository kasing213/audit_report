# Payment Tracker worker — macOS provisioning

Standing up the third outreach worker (`payment_tracker`) on the Mac that
already runs the Company and Personal workers.

Server-side Payment Tracker is already deployed and **inert**: its worker state
ships `paused: true`, scanning is off, and there are no drafts. Nothing in this
document causes a message to be sent. Enabling sending is a separate, later
decision — see [OUTREACH_RUNBOOK.md](OUTREACH_RUNBOOK.md) → *Payment Tracker*.

The Windows notes in the runbook (`pm2-resurrect-outreach` Scheduled Task, the
`rpc.sock` pipe conflict) do **not** apply here. macOS uses `pm2 startup` with
launchd, which works properly.

---

## 0. Before you touch anything: record the current pm2 state

```bash
pm2 list
pm2 save --help >/dev/null && cat ~/.pm2/dump.pm2 | grep -o '"name":"[^"]*"'
```

Write down every app name you see. You will compare against this at the end.

> ⚠️ **The `pm2 save` hazard — read this before running any pm2 command.**
>
> `pm2 save` writes the *currently running* process list to `~/.pm2/dump.pm2`,
> replacing whatever was there. If pm2 was restarted cold and only some apps are
> running when you save, the missing ones are **silently dropped from
> resurrect** — they will not come back after a reboot, and nothing warns you.
>
> This machine's dump may also serve other projects. If `pm2 list` shows apps
> that are not `outreach-worker-*`, they are in the same dump and are equally at
> risk.
>
> Rule: **never run `pm2 save` unless `pm2 list` shows everything that should be
> running.** Step 6 has the safe sequence.

---

## 1. Prerequisites

| Requirement | Check | Why |
|---|---|---|
| Node 18+ | `node -v` | The worker uses global `fetch`; Node 16 has none and the worker dies on its first API call |
| pm2 | `pm2 -v` | Process supervision |
| Repo at `5a58246` or later | `git log --oneline -1` | `npm run login:payment` and the session guard do not exist before it |

```bash
cd /path/to/audit-sales
git pull origin main
git log --oneline -1        # must be 5a58246 or a descendant
cd scripts/telegram-worker
npm install                 # the worker has its own node_modules
```

---

## 2. Check `.env` (do not add ORG_ID)

`scripts/telegram-worker/.env` is shared by all three workers. It should already
have these from the existing setup:

```
BASE_URL=https://auditreport-production.up.railway.app
AGENT_TOKEN=<the agent token — must differ from DASHBOARD_TOKEN>
TELEGRAM_API_ID=<from https://my.telegram.org/apps>
TELEGRAM_API_HASH=<same>
```

**Do not set `ORG_ID` or `STRING_SESSION_PATH` in `.env`.** Both are set
per-app by the pm2 config, and a value in `.env` would apply to whichever worker
you happen to start by hand.

### Behaviour change you need to know about

`ORG_ID` is now **required**. It used to default to `'company'`. A worker
started without it now exits immediately instead of guessing:

```
ORG_ID must be explicitly set to one of: company, personal, payment_tracker
```

This is deliberate — the old default meant a mistyped Payment worker would have
sent Company outreach from the payment account. The three pm2 apps all set
`ORG_ID` explicitly, so they are unaffected. Only a manual `npm start` is:

```bash
ORG_ID=company STRING_SESSION_PATH=./telegram-string-session.txt npm start
```

---

## 3. Create the Payment Tracker session

From `scripts/telegram-worker`:

```bash
npm run login:payment
```

The code goes to the **Payment Tracker Telegram account**, not yours. Have that
phone available.

This is a separate command from `npm run login` on purpose. That one writes
wherever `STRING_SESSION_PATH` points; a typo there would overwrite the Company
session, take its worker offline, and hand its outreach to the wrong account.
`login:payment` takes no path argument at all. It will only ever create:

```
scripts/telegram-worker/telegram-string-session-payment-tracker.txt
```

It refuses Company/Personal session names, any `../` traversal, any path
resolving outside the worker directory, and any symlinked parent. It writes with
`openSync(..., 'wx', 0o600)` — so an existing file is never clobbered
(atomically, no check-then-write race), the credential is owner-readable only,
and a cancelled login leaves nothing behind to block a retry.

### macOS gotcha: symlinked paths

The guard compares `realpath(cwd)` against the resolved path and refuses if they
differ. This is more likely to bite on macOS than Windows — it triggers if the
repo lives under a symlink, for example inside iCloud Drive, under `/Volumes/`,
or in a directory you symlinked into `~`.

If you see:

```
refusing to write the payment session through a symlinked directory
```

the guard is working as intended. Move or clone the repo to a real path
(`~/projects/audit-sales` is fine) and re-run. Do not work around it by editing
the guard — the check exists so a session credential cannot be written somewhere
other than where you think.

### Verify the session is the right account

```bash
node whoami-session.js
```

Confirm it reports the Payment Tracker account, not Company or Personal. If it
reports the wrong one, delete the file and start over — sending from the wrong
number is the failure this whole guard exists to prevent.

---

## 4. Confirm the server side is paused

Before starting a process that polls for work, confirm the server will not give
it any:

```bash
curl -s -H "Authorization: Bearer $AGENT_TOKEN" \
     -H "Accept: application/json" \
     -H "X-Org-Id: payment_tracker" \
     https://auditreport-production.up.railway.app/crm/api/outreach/worker-status
```

Expected:

```json
{"org":"payment_tracker","paused":true,"auto_approve":false,"daily_cap":15}
```

`paused: true` is what makes step 5 safe. If it says `false`, stop and pause it
in the dashboard first.

---

## 5. Start the worker

```bash
pm2 start ecosystem.payment-tracker.config.js
pm2 logs outreach-worker-payment-tracker --lines 30
```

This is a **separate ecosystem file** from `ecosystem.config.js` on purpose.
Adding a third app there would mean your next routine `pm2 start
ecosystem.config.js` silently starts the payment worker too — possibly before
anyone has decided the pipeline is ready. Starting it stays an explicit act.

Expected in the logs: a successful MTProto connection, then heartbeats. It will
report `paused` and claim nothing. That is correct.

`DAILY_CAP=15` in that file is defence in depth only. The server is
authoritative — it reserves a delivery slot before verification and releases it
if nothing sends, so concurrent workers cannot exceed the cap.

---

## 6. Persist across reboots — safely

```bash
pm2 list          # ALL THREE outreach workers + anything else that belongs
```

Only when that list is complete:

```bash
pm2 save
pm2 startup       # prints a sudo command — run exactly what it prints
```

`pm2 startup` on macOS installs a launchd agent. Unlike Windows, this works
natively; there is no Scheduled Task to create and no `rpc.sock` pipe conflict
to avoid.

Verify the dump has everything:

```bash
grep -o '"name":"[^"]*"' ~/.pm2/dump.pm2
```

Compare against what you wrote down in step 0, plus
`outreach-worker-payment-tracker`. If anything is missing, start it and
`pm2 save` again.

---

## 7. Verify isolation

The point of the third worker is that it cannot touch the other two.

```bash
# Payment heartbeat appears
curl -s -H "Authorization: Bearer $AGENT_TOKEN" -H "Accept: application/json" \
     -H "X-Org-Id: payment_tracker" \
     https://auditreport-production.up.railway.app/crm/api/outreach/worker-status

# Company still reports its own state, unchanged
curl -s -H "Authorization: Bearer $AGENT_TOKEN" -H "Accept: application/json" \
     -H "X-Org-Id: company" \
     https://auditreport-production.up.railway.app/crm/api/outreach/worker-status

# A missing workspace header is rejected, not defaulted to Company
curl -s -o /dev/null -w "%{http_code}\n" \
     -H "Authorization: Bearer $AGENT_TOKEN" -H "Accept: application/json" \
     https://auditreport-production.up.railway.app/crm/api/outreach/worker-status
# expect 400
```

Then check the dashboard: Company and Personal `last_heartbeat_at` should keep
advancing on their own workers, and their `deliveries_today` must not move
because of anything Payment did.

---

## 8. Stopping / rolling back

```bash
pm2 stop outreach-worker-payment-tracker
pm2 delete outreach-worker-payment-tracker
pm2 save        # only with the other workers running — see step 0
```

Deleting the app does not delete the session file. To fully undo, also remove
`telegram-string-session-payment-tracker.txt` — and be aware you will need the
Payment account's phone again to recreate it.

---

## What still will not happen after all this

The worker is running, paused, and correctly isolated. It will not send anything
until, in order:

1. `PAYMENT_TRACKER_DATABASE_URL` is a collection-scoped read-only credential
   (`find` + `listIndexes` on `ar_tracker.ar_state` only) and
   `npx ts-node scripts/check-payment-tracker-source.ts` exits 0.
2. Reminder wording is saved **and approved** in the dashboard.
3. `PAYMENT_TRACKER_SCAN_ENABLED=true` on Railway, or a manual **Scan now**.
4. The Payment worker is resumed in the dashboard.

Each of those is refused independently until the one before it is done.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `ORG_ID must be explicitly set` | Manual `npm start` without `ORG_ID`; use the pm2 config or set it inline |
| `refusing to write the payment session through a symlinked directory` | Repo is under a symlinked path (iCloud, `/Volumes`, symlinked `~` dir) — move it |
| `EEXIST` on login | Session file already exists; the guard will not overwrite. Verify with `whoami-session.js` before deleting |
| Worker exits instantly, no logs | Node < 18 — no global `fetch` |
| HTTP 400 from every API call | Missing/invalid `X-Org-Id`; pm2 config sets it, a manual run may not |
| HTTP 401/403 | `AGENT_TOKEN` wrong, or equal to `DASHBOARD_TOKEN` (the server refuses to downgrade to agent role in that case) |
| Company/Personal stop resurrecting after reboot | `pm2 save` ran while they were not running — see step 0 |
| Worker heartbeats but never sends | Expected: it is paused, and there are no approved payment drafts |
