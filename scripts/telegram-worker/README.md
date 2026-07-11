# Telegram outreach worker (MTProto / gramjs)

Pulls approved outreach proposals from the CRM, sends each via the user's
Telegram account using MTProto (the same protocol the official Telegram apps
speak), reports back. Listens for inbound replies in real-time and forwards
them to the audit-trail group via the bot.

The worker can run on a laptop (simplest) or on Railway as a second service
sharing the same repo (production setup, see "Run on Railway" below).

## How it talks to the API

The worker authenticates as a **restricted `agent` role** via Bearer token.
That role can only call nine endpoints — `claim`, `mark-sent`, `mark-failed`,
`worker-heartbeat`, `worker-alert`, `worker-status`, `report-inbound`,
`:id/effective-image` (image bytes to send), and `default-video-url` (presigned
R2 URL for the marketing video). Everything else returns `403`. So if the
worker's credential is ever pulled off the disk it can't be used to read
customer data, generate batches,
approve proposals, or pause itself.

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
cp .env.example .env
```

Edit `.env`:

- `BASE_URL` — your deployed CRM URL.
- `AGENT_TOKEN` — Bearer for the worker-only routes. Generate with
  `openssl rand -hex 32`. **Must differ from the server's `DASHBOARD_TOKEN`**.
  Same value goes into the server's `AGENT_TOKEN` Railway env var.
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` — get from
  https://my.telegram.org/apps (free, takes 30 seconds). These identify the
  *app*, not the user account.
- `DAILY_CAP` — daily send ceiling. Start low (10–15).
- `MIN_DELAY_SEC` / `MAX_DELAY_SEC` — per-send random delay window.

## Log in (one time per account)

```bash
npm run login
```

You'll be prompted for your phone number, the SMS code Telegram sends to your
existing app, and (if set) your 2FA password. The session is saved as a
single string blob to `telegram-string-session.txt` (gitignored). Treat that
file like a password — it grants full access to your Telegram account.

## Run the worker (laptop)

```bash
npm run start
```

For an unattended laptop, run it under **pm2** instead so it auto-restarts on
crash and bounces nightly. See "Run under pm2" below.

The worker:

- polls `/crm/api/outreach/claim` every 60 s for approved proposals,
- sends each via `client.sendMessage(+phone, message)` over MTProto,
- maintains a real-time `NewMessage` listener that POSTs every incoming
  private-chat reply to `/crm/api/outreach/report-inbound`,
- posts a heartbeat to `/crm/api/outreach/worker-heartbeat` every 30 s (the
  dashboard shows liveness based on this),
- reads the server-side pause flag every iteration.

## Run under pm2 (laptop, recommended)

`ecosystem.config.js` defines the worker as a pm2 app (`outreach-worker`). pm2
auto-restarts it on crash and bounces it nightly at 10pm (laptop-local time)
via `cron_restart: '0 22 * * *'`.

```bash
pm2 start scripts/telegram-worker/ecosystem.config.js
pm2 save        # persist the process list for resurrect
pm2 logs outreach-worker
```

**Boot persistence on Windows:** pm2's native `pm2 startup` does NOT work on
Windows (`Init system not found`). Use a **logon Scheduled Task** that runs
`pm2 resurrect` as the user (the worker returns shortly after you log in). Full
setup + the verification steps are in `OUTREACH_RUNBOOK.md` → "Boot persistence".

> ⚠️ Do NOT run pm2 as a Windows Service (pm2-installer) alongside this — pm2 on
> Windows shares one global pipe `\\.\pipe\rpc.sock` that isn't namespaced by
> `PM2_HOME`, so a LocalService pm2 service blocks the user-level pm2 with
> `connect EPERM` and the worker never resurrects. See the runbook for the
> disable-and-recover steps.

A stale heartbeat is caught by the server-side watchdog (see Alerts), so even if
pm2 itself is down you still get notified during work hours.

## Run on Railway (production)

1. Create a second Railway service from the same repo. Point it at
   `Dockerfile.worker`. Runtime port: none (worker doesn't listen).
2. Attach a Railway Volume mounted at `/data`.
3. Env vars:
   - `BASE_URL` — public URL of the API service (e.g.
     `https://auditreport-production.up.railway.app`).
   - `AGENT_TOKEN` — same value as the API service's `AGENT_TOKEN`.
   - `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`.
   - `STRING_SESSION_PATH=/data/telegram-string-session.txt`.
   - `DAILY_CAP`, `MIN_DELAY_SEC`, `MAX_DELAY_SEC` — same as laptop.
4. Run `npm run login` once locally and upload the generated
   `telegram-string-session.txt` into the Railway volume at `/data`. Without
   this file the worker exits with code 1 and emits a `session-expired` alert.
5. Restart policy: ALWAYS. The Dockerfile is set up so a session-expired exit
   triggers an alert before the container is restarted.

## Controls

- **Pause**: click **Pause** on the Outreach UI (`/crm/outreach`). The worker
  reads the pause flag every iteration; no restart needed. Click **Resume** to
  unpause.
- **Stop**: Ctrl-C (or stop the Railway service).
- **Disable inbound listener only**: set `INBOUND_DISABLED=true` in the env.
  The send loop continues normally.
- **Re-login**: delete `telegram-string-session.txt` (or
  `/data/telegram-string-session.txt` on Railway) and rerun `npm run login`.

## Alerts

The worker posts manager alerts to the audit Telegram chat in these cases:

- Telegram reports the send failed (per-customer alert with deeplink).
- The same proposal's lease expires three times without resolving → marked
  `failed`, single alert.
- Telegram session is invalid (auth key revoked / unregistered) →
  `session-expired` alert, worker exits 2, Railway restarts the container.
- Worker process crashes → `worker-fatal` alert.
- (Server-side) Worker heartbeat stale beyond `HEARTBEAT_STALE_MINUTES`
  (default 15) during work hours → `worker-offline` alert. Fired by
  `HeartbeatWatchdogScheduler` on Railway, gated on
  `HEARTBEAT_WATCHDOG_ENABLED=true`, delivered to `WORKER_ALERT_CHAT_ID`
  (operator DM). The watchdog cron (`*/5 9-21 * * *`) deliberately never ticks
  overnight so a sleeping laptop doesn't false-alarm.

Customer replies land in the audit-trail group as `📥 New customer reply`
posts (separate from failure alerts). One Telegram session, two alert
channels going through the same bot.

## Safety

- Daily cap + random 60–180 s delay keep send behaviour indistinguishable
  from a human.
- Server-side `claims_today` counter caps total claims even if a worker is
  duplicated or restarts mid-day.
- Every message was reviewer-LLM-approved AND (operator-approved OR
  auto-approve-gate-passed) in the CRM before it could be claimed.
- On any send failure (phone not on Telegram, peer invalid, session expiry)
  the proposal is flipped to `failed` with a reason — no silent retries.

## Implementation notes — MTProto

- Peer resolution: a fresh lead's number isn't in the account's contacts, so
  `getEntity(phone)` throws. The worker uses `contacts.ImportContacts`
  (`importPhoneAsPeer`), which returns the `User` **iff** the number is on
  Telegram AND their privacy permits phone lookup — otherwise `null`, mapped to
  `phone number not on Telegram (or hidden by privacy)`. The imported contact is
  deleted afterward so the address book doesn't balloon. `PHONE_NUMBER_INVALID`
  is mapped separately to `phone number invalid (permanent)`.
- Sending: the worker fetches the effective image (mandatory) and the default
  video (via `default-video-url`, if set), then sends **image + video as one
  album** (`client.sendFile(peer, { file: [img, video], … })`) with the message
  as caption (≤ 1024 chars) or a follow-up bubble. With no video it falls back to
  an image-only send. `SEND_TIMEOUT_SEC` (default 240 s) bounds the whole send
  because the video is downloaded from R2 first. See `../../OUTREACH_MEDIA.md`.
- On any send failure the proposal is flipped to `failed` with a reason; the
  server records it in `outreach_suppressions` so the number isn't re-hammered
  (privacy failures are retried every 60 days, up to 3 times). See
  `../../OUTREACH_MEDIA.md`.
- Inbound: `client.addEventHandler(handler, new NewMessage({ incoming: true }))`
  pushes events as soon as Telegram delivers them. Handler filters to
  `Api.PeerUser` (private chats only) and posts to `/report-inbound`.
- Phone resolution for incoming events: when we send, we cache
  `userId → phone` in memory. On inbound, we look up the cache first; on
  miss, we call `client.getEntity(userId)` and read `user.phone` (which
  Telegram exposes after the customer has messaged us). Customers whose
  phone privacy hides them from us are logged and skipped.

## Gotchas

- **Sending to your own phone routes to Saved Messages.** Telegram resolves
  your own number to the Saved-Messages chat. Test with a phone other than
  the worker account's.
- **Rate-limit the queue, not just the worker.** The server enforces
  `DAILY_CAP` via the `claims_today` counter on `outreach_worker_state`, so
  even if you accidentally run two workers they share the cap atomically.
- **Failed proposals are not auto-retried.** `failed` is a terminal status —
  re-generate to get another draft.
- **The `agent` Bearer is path-restricted, not data-restricted.** It can
  call `/claim` and learn proposal contents (message + phone). Treat
  `AGENT_TOKEN` like a customer-data secret.
- **Inbound dedup happens server-side.** The unique compound index on
  `(phone, telegram_message_id)` in `inbound_messages` means re-running
  the worker on the same chat history won't double-alert.
