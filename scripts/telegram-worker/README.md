# Telegram outreach worker

Pulls approved outreach proposals from the CRM, opens each customer's Telegram
Web chat with your sales account, types the AI-drafted Khmer message, clicks
Send, reports back to the CRM.

The worker can run on a laptop (simplest) or on Railway as a second service
sharing the same repo (production setup, see "Run on Railway" below).

## How it talks to the API

The worker authenticates as a **restricted `agent` role** via Bearer token.
That role can only call six endpoints — `claim`, `mark-sent`, `mark-failed`,
`worker-heartbeat`, `worker-alert`, `worker-status`. Everything else returns
`403`. So if the worker's credential is ever pulled off the disk it can't be
used to read customer data, generate batches, approve proposals, or pause
itself.

The `agent` role is granted by the server's `AGENT_TOKEN` env var. The legacy
`WORKER_TOKEN` env var still works (logs a deprecation warning) but should be
migrated to `AGENT_TOKEN`. **`AGENT_TOKEN` must be different from
`DASHBOARD_TOKEN`** — if they match the server logs a fatal warning and
refuses to downgrade to the agent role (fail-safe), so the worker would end
up with full developer privileges.

## One-time setup (laptop)

```bash
cd scripts/telegram-worker
npm install
npx playwright install chromium
cp .env.example .env
```

Edit `.env`:

- `BASE_URL` — your deployed CRM URL.
- `AGENT_TOKEN` — Bearer for the worker-only routes. Generate with
  `openssl rand -hex 32`. **Must differ from the server's `DASHBOARD_TOKEN`**.
  Same value goes into the server's `AGENT_TOKEN` Railway env var.
- `DAILY_CAP` — daily send ceiling. Start low (10–15).
- `MIN_DELAY_SEC` / `MAX_DELAY_SEC` — per-send random delay window.

## Log in to Telegram Web (one time per account)

```bash
npm run login
```

A Chromium window opens. Sign in with the sales phone number (SMS code +
optional 2FA). When your chat list is visible, return to the terminal and
press ENTER. The session is saved to `telegram-session.json` (gitignored).

## Run the worker (laptop)

```bash
npm run start
```

The worker polls `/crm/api/outreach/claim` every 60 s, posts a heartbeat to
`/crm/api/outreach/worker-heartbeat` every 30 s (the dashboard shows liveness
based on this), and reads the server-side pause flag every iteration.

## Run on Railway (production)

1. Create a second Railway service from the same repo. Point it at
   `Dockerfile.worker`. Runtime port: none (worker doesn't listen).
2. Attach a Railway Volume mounted at `/data`.
3. Env vars:
   - `BASE_URL` — public URL of the API service (e.g.
     `https://auditreport-production.up.railway.app`).
   - `AGENT_TOKEN` — same value as the API service's `AGENT_TOKEN`.
   - `STORAGE_STATE=/data/telegram-session.json` (Dockerfile defaults this,
     keep it consistent if you override).
   - `DAILY_CAP`, `MIN_DELAY_SEC`, `MAX_DELAY_SEC` — same as laptop.
4. Run `npm run login` once locally and upload the generated
   `telegram-session.json` into the Railway volume at `/data` (e.g. via
   `railway run` + `mv`, or your preferred channel). Without this file the
   worker exits with code 1 and emits a `session-expired` alert.
5. Restart policy: ALWAYS. The Dockerfile is set up so a session-expired exit
   triggers an alert before the container is restarted.

## Controls

- **Pause**: click **Pause** on the Outreach UI (`/crm/outreach`). The worker
  reads the pause flag every iteration; no restart needed. Click **Resume** to
  unpause.
- **Stop**: Ctrl-C (or stop the Railway service).
- **Re-login**: delete `telegram-session.json` (or `/data/telegram-session.json`
  on Railway) and rerun `npm run login`.

## Alerts

The worker posts manager alerts to the audit Telegram chat in these cases:

- Telegram Web reports the send failed (per-customer alert with deeplink).
- The same proposal's lease expires three times without resolving → marked
  `failed`, single alert.
- Telegram Web session is invalid → `session-expired` alert, worker exits 2,
  Railway restarts the container.
- Worker process crashes → `worker-fatal` alert.
- (Server-side) Worker heartbeat older than 5 min while at least one approved
  proposal is queued → `worker-offline` alert (planned).

## Safety

- Daily cap + random 60–180 s delay keep send behaviour indistinguishable from a human.
- Server-side `claims_today` counter caps total claims even if a worker is
  duplicated or restarts mid-day.
- Every message was reviewer-LLM-approved AND (operator-approved OR
  auto-approve-gate-passed) in the CRM before it could be claimed.
- On any send failure (phone not on Telegram, UI change, session expiry) the
  proposal is flipped to `failed` with a reason — no silent retries.

## Implementation notes — Telegram Web

- The `/a/` (TGCloud Z) variant of Telegram Web does **not** honour
  `#?phone=...` URL hashes. The worker uses the `tgaddr` form instead:
  `https://web.telegram.org/a/#?tgaddr=tg%3A%2F%2Fresolve%3Fphone%3D<digits>`.
  This opens the right chat as long as the phone is registered with Telegram.
- The strict success check is two-step: composer must clear after pressing the
  send button, AND a `.Message.own` (or `.bubble.is-out`) bubble must render
  with the message text. The composer-clear half is what catches selectors
  silently no-op'ing on Telegram Web UI changes.
- On any send-side failure the worker dumps `debug-fail-<timestamp>.png` and
  `.html` next to itself (gitignored). When you redeploy after a Telegram Web
  UI change, those tell you exactly which selector drifted.

## Gotchas

- **Sending to your own phone routes to Saved Messages.** Telegram resolves
  `tg://resolve?phone=<digits>` for your own number to the special
  Saved-Messages chat, which never triggers a notification. If a proposal's
  customer phone matches the sales account's login phone, the worker will
  succeed — and you'll see the message in Saved Messages, not as an inbound
  notification on a second device. Test deliveries with a phone *other* than
  the sales account's.
- **Rate-limit the queue, not just the worker.** The server enforces
  `DAILY_CAP` via the `claims_today` counter on `outreach_worker_state`, so
  even if you accidentally run two workers (laptop + Railway) they share the
  cap atomically. The atomic claim happens in `tryReserveClaim()`.
- **Failed proposals are not auto-retried.** `failed` is a terminal status —
  the worker never reclaims a failed proposal. Re-generate (e.g. via the
  `Test on me` button or `Generate batch`) to get another draft.
- **The `agent` Bearer is path-restricted, not data-restricted.** It can call
  `/claim` and learn proposal contents (message + phone). Treat
  `AGENT_TOKEN` like a customer-data secret even though its API surface is
  small.
