# Cambodia scheduler timezone + pre-run pm2 bounce

**Date:** 2026-08-01
**Branch:** `feature/outreach-multi-org`
**Status:** approved design, pending implementation plan

## Problem

Two related operational defects, both about *when* things fire.

1. **The daily outreach scan runs an hour early.** `OutreachScheduler` uses
   `'0 9 * * *'` with `tz = process.env.TIMEZONE || 'Asia/Kuala_Lumpur'`
   (`src/scheduler/outreach-scheduler.ts:8,56-57`), and `.env` sets
   `TIMEZONE=Asia/Kuala_Lumpur`. Kuala Lumpur is UTC+8, Cambodia is UTC+7, so
   the scan that reads as "9am" actually drafts the day's batch at **08:00
   Cambodia time**. The operator wants it back at 9am Cambodia. The same
   `TIMEZONE` var drives four other schedulers, all off by the same hour.

2. **The pm2 bounce is 11 hours from the work it precedes.** Both workers
   restart at `'0 22 * * *'` laptop-local (`ecosystem.config.js:27`). A daily
   fresh process is worth having — it clears the gramjs connection and any
   accumulated leak before the day's sending — but at 10pm it is nowhere near
   the batch it should be preparing for.

## Non-goals

- No change to `DAILY_CAP`, delay windows, or any sending behaviour.
- No change to `REPORT_TIMEZONE` (`Asia/Phnom_Penh`) or `src/utils/time.ts`,
  which already resolve reports correctly.
- No second scheduling system (no Windows Scheduled Task beyond the existing
  logon `pm2 resurrect` task documented in the runbook).

---

## Measured baseline (2026-08-01)

| Fact | Value | Source |
|---|---|---|
| Laptop timezone | SE Asia Standard Time, UTC+7 | `Get-TimeZone` |
| Scheduler timezone | `Asia/Kuala_Lumpur`, UTC+8 | `.env` |
| Report timezone | `Asia/Phnom_Penh`, UTC+7 | `.env`, `src/utils/time.ts:36` |
| Outreach scan cron | `0 9 * * *` → fires 08:00 Cambodia | `outreach-scheduler.ts:8` |
| pm2 bounce | `0 22 * * *` laptop-local | `ecosystem.config.js:27` |

The codebase already carries a correct Cambodia timezone for reports. The
KL value on the scheduler side is a leftover, not a deliberate choice.

---

## Design

### 1. Cambodia time for every scheduler

Set `TIMEZONE=Asia/Phnom_Penh`, **and** change the hardcoded
`|| 'Asia/Kuala_Lumpur'` fallback at every site that reads it. Flipping the
fallback matters as much as flipping the env var: a KL default silently
reasserts the bug anywhere the env var is absent — which is precisely how the
scan came to run at 8am. After this change every cron expression in the repo
means what it says in Cambodia local time.

Effect on the five affected schedulers (all shift one hour later in absolute
terms, landing on their stated hour in Cambodia):

| Scheduler | Cron | Before | After |
|---|---|---|---|
| Outreach scan | `0 9 * * *` | 08:00 | **09:00** |
| Promise reminder | `0 8 * * *` | 07:00 | 08:00 |
| Ad scanner | `30 9 * * *` | 08:30 | 09:30 |
| Monthly rollup | `1 0 1 * *` | 23:01 prev day | 00:01 |
| Heartbeat watchdog | `*/5 9-21 * * *` | 08:00–20:55 | 09:00–21:55 Cambodia |

`src/utils/time.ts` is deliberately excluded — its fallbacks are
`Asia/Phnom_Penh` (reports) and `UTC` (generic), both already correct.

### 2. Pre-run pm2 bounce at 08:30

`cron_restart` becomes `'30 8 * * *'`, replacing the 22:00 entry. pm2 allows
one `cron_restart` per app; one restart per day is all the nightly bounce ever
provided, so this relocates it rather than adding to it. 08:30 laptop-local is
08:30 Cambodia (both UTC+7), putting the fresh process 30 minutes ahead of the
09:00 scan.

08:30 also sits **outside** the watchdog's new 09:00–21:55 window
(`*/5 9-21 * * *`), so the heartbeat gap during the restart cannot fire a false
`worker-offline` alert. This is load-bearing: a bounce at 09:30 would have been
inside the window.

### 3. Files

| File | Change |
|---|---|
| `.env` | `TIMEZONE=Asia/Phnom_Penh` |
| `src/scheduler/outreach-scheduler.ts:57` | fallback → `Asia/Phnom_Penh` |
| `src/scheduler/heartbeat-watchdog-scheduler.ts:31` | same |
| `src/scheduler/promise-scheduler.ts:26` | same |
| `src/scheduler/monthly-scheduler.ts:76,80` | same |
| `src/ad-scanner/ad-scanner-scheduler.ts:38` | same |
| `scripts/telegram-worker/ecosystem.config.js:27` | `cron_restart: '30 8 * * *'` + comment |
| `scripts/telegram-worker/README.md:107-108` | 10pm → 08:30 pre-run |
| `OUTREACH_RUNBOOK.md:135-136` | bounce time + rationale |
| `OUTREACH_RUNBOOK.md:199,278` | `TIMEZONE` default rows |
| `COMMANDS.md:240` | sample value |
| `RAILWAY_DEPLOYMENT.md:39` | sample value |
| `scripts/check-bounce-precedes-scan.js` | new — see Verification |

---

## Out-of-repo steps (operator)

Neither is reachable from the repo, and skipping either makes the committed
change inert. Both belong in the runbook as part of this work.

1. **Railway:** set `TIMEZONE=Asia/Phnom_Penh` on the API service. The `.env`
   edit governs local dev only; the 09:00 scan runs on Railway against *its*
   env var. Until this is set the scan stays at 08:00 Cambodia no matter what
   is committed. The fallback change in §1 is the backstop if it is forgotten,
   but Railway's env var wins where present, so it must be updated.
2. **pm2:** editing `ecosystem.config.js` alone changes nothing — pm2 serves
   `cron_restart` from its saved dump, not from the file. Requires:
   ```
   pm2 delete ecosystem.config.js
   pm2 start  ecosystem.config.js
   pm2 save
   ```

## Accepted behaviour

- **A sleeping laptop misses the bounce.** pm2 does not catch up a missed
  `cron_restart`. The worker keeps running on its existing process and still
  serves the 09:00 batch, because it polls `/claim` every 60s regardless of
  process age. The bounce is hygiene, not a precondition.
- **One-off shifts on changeover day.** The four non-outreach schedulers each
  skip or repeat nothing; they simply fire an hour later from the next tick on.

## Verification

- `npm run typecheck` — covers all six TypeScript edits. The repo has no test
  framework; this is the available static gate.
- `scripts/check-bounce-precedes-scan.js` — new assertion script in the style
  of the existing `scripts/check-scan-topup.js` (referenced at
  `outreach-scheduler.ts:29`). Parses `cron_restart` out of
  `ecosystem.config.js` and `DEFAULT_CRON` out of `outreach-scheduler.ts`,
  resolves both to minutes-since-midnight in Cambodia time, and asserts the
  bounce strictly precedes the scan. This encodes the invariant that actually
  broke — a comment claiming "before the scan" cannot fail when someone edits
  one cron and not the other.
- Manual confirmation after deploy: the API service log line
  `Outreach scheduler started (cron='0 9 * * *', tz='Asia/Phnom_Penh')`, and
  `pm2 describe outreach-worker-company` showing the new `cron_restart`.
