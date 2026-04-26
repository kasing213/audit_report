# Telegram outreach worker

Pulls approved outreach proposals from the CRM, opens each customer's Telegram
Web chat with your sales account, types the AI-drafted Khmer message, clicks
Send, reports back to the CRM.

The worker can run on a laptop (simplest) or on Railway as a second service
sharing the same repo (production setup, see "Run on Railway" below).

## One-time setup (laptop)

```bash
cd scripts/telegram-worker
npm install
npx playwright install chromium
cp .env.example .env
```

Edit `.env`:

- `BASE_URL` — your deployed CRM URL.
- `WORKER_TOKEN` — Bearer token for the worker-only routes. Must match either
  the server's `DASHBOARD_TOKEN` or its `WORKER_TOKEN` (preferred — using a
  dedicated `WORKER_TOKEN` means the worker's credential cannot also unlock
  the operator UI).
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
   - `WORKER_TOKEN` — the server's `WORKER_TOKEN` (or `DASHBOARD_TOKEN` as a
     fallback).
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
