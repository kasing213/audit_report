# Outreach daily-cap delivery report — design

## Problem

When an outreach worker (`scripts/telegram-worker/worker.ts`) hits its daily
delivery cap (15/day), nothing is reported. The worker just logs
`Server daily cap reached.` to its own console and keeps idling. Kasing has
no way to know a session finished without checking logs.

There's an existing audit group (`AUDIT_CHAT_ID`) for boss/dev visibility,
but this new notification should go to Kasing's **personal** Telegram chat
only, kept separate from the audit group.

## Trigger

Edge-triggered, not polled. In the worker's send loop
(`scripts/telegram-worker/worker.ts:588-592`), right after a successful send
increments `workerState.sentToday`, check whether it just reached
`DAILY_CAP` (15). Fires once per org per day, at the moment the 15th message
is delivered — not on every subsequent poll while the worker sits idle at
cap.

## Alert kind

Add `'daily-cap-reached'` to the `AlertKind` union in
`src/outreach/outreach-alerts.ts`, with its own message template in
`formatProposalAlert`:

```
✅ *Outreach delivery cap reached* (company)

Delivered: 15/15 today.
Resumes after UTC midnight reset.
```

Reuses the existing alert pipeline end-to-end:
`worker.ts` → `postAlert('daily-cap-reached', '15/15')` → `POST
/crm/api/outreach/worker-alert` (`src/api/outreach-routes.ts:258`) →
`notifyOutreachFailure(null, 'daily-cap-reached', { reason, worker_id, org })`
(`src/outreach/outreach-alerts.ts:110`). No new endpoint needed.

## Destination

New env var: `OWNER_CHAT_ID = 1450060367` (Kasing's personal Telegram chat).

The name is deliberately not `PERSONAL_CHAT_ID` — `'personal'` is already an
`org` value elsewhere in this codebase (company vs. personal outreach
workspace), and a `PERSONAL_CHAT_ID` env var next to a `'personal'` org
would be easy to misread as "the chat id for the personal org" rather than
"Kasing's own chat."

In the `worker-alert` route, when `kind === 'daily-cap-reached'`, pass
`chatId: process.env.OWNER_CHAT_ID` into `notifyOutreachFailure`'s context
(the function already supports a `ctx.chatId` override — same mechanism the
heartbeat watchdog uses to DM the operator directly instead of the audit
group, per the existing comment at `outreach-alerts.ts:50-52`).

If `OWNER_CHAT_ID` is unset, drop the alert with a logged warning — do
**not** fall back to `AUDIT_CHAT_ID`. Boss/dev's audit group should never
receive this notification; that separation is the point.

## Throttle

Add `'daily-cap-reached'` to `WORKER_LEVEL_KINDS` in `outreach-alerts.ts` —
throttled per `(kind, org)` with the existing 30-minute window. This is a
safety net (the edge-trigger in the worker loop should only ever fire once
per org per day), not the primary dedupe mechanism.

## Multi-org behavior

This branch (`feature/outreach-multi-org`) runs one worker process per org
(`ORG_ID` env var, e.g. `company` / `personal`). Each org's worker fires its
own tagged alert independently when *that org* reaches 15 deliveries for the
day. If multiple orgs are running, Kasing may get more than one message a
day, each labeled with its org — this is intentional, not a bug to dedupe
away, since orgs cap independently at different times.

## Content (per approved scope)

Count + status only — no per-customer breakdown, no failure/skip detail.
That data already exists elsewhere (the audit group's daily JPG report and
`outreach-alerts.ts`'s existing failure-kind alerts); this notification is
purely "session done, N/15 delivered."

## Files touched

- `src/outreach/outreach-alerts.ts` — new `AlertKind`, message template,
  `WORKER_LEVEL_KINDS` entry.
- `src/api/outreach-routes.ts` — `chatId` override for this kind in the
  `worker-alert` route.
- `scripts/telegram-worker/worker.ts` — fire `postAlert('daily-cap-reached',
  ...)` on the edge-trigger after `workerState.sentToday` reaches
  `DAILY_CAP`.
- `.env` (not committed) / Railway env — add `OWNER_CHAT_ID=1450060367`.
- `OUTREACH_RUNBOOK.md` — document `OWNER_CHAT_ID` alongside the existing
  `AUDIT_CHAT_ID`/`REPORT_CHAT_ID`/`SUMMARY_CHAT_ID` table.

## Out of scope

- No changes to the audit group's existing daily JPG report.
- No changes to cap enforcement logic (`OutreachWorkerStateRepository`) —
  this is purely a notification on top of the existing cap mechanics.
- No retry/backoff on the alert send itself — same fire-and-log-on-failure
  behavior as every other `notifyOutreachFailure` call site.
