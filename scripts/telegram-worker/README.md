# Telegram outreach worker

Runs on your laptop. Pulls approved outreach proposals from the CRM, opens
each customer's Telegram Web chat with your sales account, types the
AI-drafted Khmer message, clicks Send, reports back to the CRM.

## One-time setup

```bash
cd scripts/telegram-worker
npm install
npx playwright install chromium
cp .env.example .env
```

Edit `.env`:

- `BASE_URL` — your deployed CRM URL.
- `WORKER_TOKEN` — must equal the server's `DASHBOARD_TOKEN`.
- `DAILY_CAP` — daily send ceiling. Start low (10–15).
- `MIN_DELAY_SEC` / `MAX_DELAY_SEC` — per-send random delay window.

## Log in to Telegram Web (one time per account)

```bash
npm run login
```

A Chromium window opens. Sign in with the sales phone number (SMS code +
optional 2FA). When your chat list is visible, return to the terminal and
press ENTER. The session is saved to `telegram-session.json` (gitignored).

## Run the worker

```bash
npm run start
```

The worker polls `/crm/api/outreach/claim` every 60 s. When it gets an
approved proposal, it navigates to the customer's chat, sends the message,
and calls `mark-sent` (which logs a lead event on the CRM too).

## Controls

- **Pause**: set `PAUSE=true` in `.env` and restart → the worker idles.
- **Stop**: Ctrl-C.
- **Re-login**: delete `telegram-session.json` and rerun `npm run login`.

## Safety

- Daily cap + random 60–180 s delay keep send behaviour indistinguishable from a human.
- Every message was human-approved in the CRM before it could be claimed.
- On any send failure (phone not on Telegram, UI change, session expiry) the
  proposal is flipped to `failed` with a reason — no silent retries.
