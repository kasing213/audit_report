# Cambodia Timezone + Pre-Run pm2 Bounce Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every scheduler cron onto Cambodia time (`Asia/Phnom_Penh`) so the "9am" outreach scan actually fires at 09:00 Cambodia, and relocate the pm2 worker bounce from 22:00 to 08:30 so both workers get a fresh process 30 minutes before that scan.

**Architecture:** Three tasks, test-first. Task 1 writes a static-analysis guard (`scripts/check-bounce-precedes-scan.js`) that parses the cron expressions and timezone fallbacks straight out of the source files and asserts the invariants; it **fails** against today's code. Tasks 2 and 3 make it pass — Task 2 moves the pm2 bounce, Task 3 flips the timezone. Docs for each change ship inside the task that makes the change.

**Tech Stack:** TypeScript (`tsc --noEmit` is the only static gate — the repo has no test framework), `node-cron` for server schedulers, pm2 `cron_restart` for the laptop workers, plain-Node assertion scripts in `scripts/` for invariant checks.

## Global Constraints

- Target timezone is **`Asia/Phnom_Penh`** (UTC+7) everywhere. Copy the string exactly; do not use `Asia/Bangkok` or `Etc/GMT-7` even though they share the offset.
- `REPORT_TIMEZONE` stays `Asia/Phnom_Penh` and `src/utils/time.ts` is **not** modified — its fallbacks (`Asia/Phnom_Penh` for reports, `UTC` for generic) are already correct and deliberate.
- pm2 `cron_restart` is **one expression per app** and has **no timezone option** — it always fires in laptop-local time. The laptop is UTC+7, which is why comparing it against the scan cron is valid only once the scan's timezone is also UTC+7.
- No new scheduling system. No Windows Scheduled Task beyond the existing logon `pm2 resurrect` task already documented in `OUTREACH_RUNBOOK.md`.
- No change to `DAILY_CAP`, send delay windows, or any sending behaviour.
- Work on branch `feature/outreach-multi-org`. Do **not** commit to `main`.
- `.env` is gitignored — edit it, but never `git add` it.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `scripts/check-bounce-precedes-scan.js` | Create | Static guard: parses cron exprs + tz fallbacks from source, asserts bounce-before-scan and Cambodia tz. No database (unlike `scripts/check-scan-topup.js`, which needs one). |
| `scripts/telegram-worker/ecosystem.config.js` | Modify:27 | pm2 process definition — holds `cron_restart`. |
| `src/scheduler/outreach-scheduler.ts` | Modify:57 | Scan cron + tz. |
| `src/scheduler/heartbeat-watchdog-scheduler.ts` | Modify:31 | Watchdog cron + tz. |
| `src/scheduler/promise-scheduler.ts` | Modify:26 | Promise reminder tz. |
| `src/scheduler/monthly-scheduler.ts` | Modify:76,80 | Monthly rollup tz (**two** occurrences). |
| `src/ad-scanner/ad-scanner-scheduler.ts` | Modify:38 | Ad scanner tz. |
| `.env` | Modify:8 | Local `TIMEZONE`. Gitignored. |
| `scripts/telegram-worker/README.md` | Modify:90-91,105-108 | Worker pm2 docs. |
| `OUTREACH_RUNBOOK.md` | Modify:135-137,199,278 | Operator runbook. |
| `COMMANDS.md` | Modify:240 | Env sample. |
| `RAILWAY_DEPLOYMENT.md` | Modify:39 | Env sample. |

---

### Task 1: Schedule-invariant guard script

Write the check first, against unmodified code, and watch it fail. This is the invariant that actually broke in production — a comment claiming "before the scan" cannot fail when someone edits one cron and not the other.

**Files:**
- Create: `scripts/check-bounce-precedes-scan.js`
- Reads (does not modify): `scripts/telegram-worker/ecosystem.config.js`, `src/scheduler/outreach-scheduler.ts`, `src/scheduler/heartbeat-watchdog-scheduler.ts`, `src/scheduler/promise-scheduler.ts`, `src/scheduler/monthly-scheduler.ts`, `src/ad-scanner/ad-scanner-scheduler.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: an executable check at `node scripts/check-bounce-precedes-scan.js`, exit `0` on pass and `1` on any failure. Tasks 2 and 3 are verified by it.

- [ ] **Step 1: Write the failing check**

Create `scripts/check-bounce-precedes-scan.js` with exactly this content:

```js
/**
 * Guards the schedule invariants that actually broke in production:
 *
 *   1. Every server scheduler falls back to Cambodia time. A stray
 *      'Asia/Kuala_Lumpur' (UTC+8) makes a cron labelled '0 9 * * *' fire at
 *      08:00 Cambodia — which is exactly how the outreach scan drifted an
 *      hour early.
 *   2. The pm2 worker bounce lands BEFORE the outreach scan, so each day's
 *      batch is drafted for a freshly restarted worker.
 *   3. The bounce lands before the heartbeat watchdog's window opens, so the
 *      restart's heartbeat gap can't raise a false `worker-offline` alert.
 *
 * Static parse only — reads the source files as text. No database and no
 * compile step, unlike scripts/check-scan-topup.js.
 *
 * Usage: node scripts/check-bounce-precedes-scan.js
 */
const fs = require('fs');
const path = require('path');

/**
 * pm2's cron_restart has no timezone option — it always fires in the clock of
 * the laptop running pm2, which is UTC+7. Comparing it against a node-cron
 * expression is therefore only meaningful when that cron's timezone is also
 * UTC+7. Hence check 1 gates checks 2 and 3.
 */
const HOST_TZ = 'Asia/Phnom_Penh';

const ROOT = path.join(__dirname, '..');
const ECOSYSTEM = path.join(__dirname, 'telegram-worker', 'ecosystem.config.js');
const OUTREACH = path.join(ROOT, 'src', 'scheduler', 'outreach-scheduler.ts');
const WATCHDOG = path.join(ROOT, 'src', 'scheduler', 'heartbeat-watchdog-scheduler.ts');

/** Every file that resolves a scheduler timezone from process.env.TIMEZONE. */
const TZ_FILES = [
  OUTREACH,
  WATCHDOG,
  path.join(ROOT, 'src', 'scheduler', 'promise-scheduler.ts'),
  path.join(ROOT, 'src', 'scheduler', 'monthly-scheduler.ts'),
  path.join(ROOT, 'src', 'ad-scanner', 'ad-scanner-scheduler.ts'),
];

let failures = 0;

function pass(label, detail) {
  console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}

function checkThat(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function extract(text, re, what, file) {
  const m = text.match(re);
  if (!m) throw new Error(`Could not find ${what} in ${rel(file)} — has the file been restructured?`);
  return m[1];
}

/**
 * '30 8 * * *' -> 510 minutes since midnight. Rejects anything that isn't a
 * single numeric minute and hour, so a list like '30 8,22 * * *' fails loudly
 * rather than being silently half-checked.
 */
function minutesOfDay(expr, what) {
  const [min, hour] = expr.trim().split(/\s+/);
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) {
    throw new Error(`${what} cron '${expr}' is not a single daily time; this check cannot compare it`);
  }
  return Number(hour) * 60 + Number(min);
}

function fmt(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// --- check 1: every scheduler falls back to Cambodia time -------------------
for (const file of TZ_FILES) {
  const matches = [...read(file).matchAll(/process\.env\.TIMEZONE \|\| '([^']+)'/g)].map((m) => m[1]);
  if (matches.length === 0) {
    failures++;
    console.log(`FAIL  ${rel(file)} has no process.env.TIMEZONE fallback — expected at least one`);
    continue;
  }
  const wrong = matches.filter((tz) => tz !== HOST_TZ);
  checkThat(
    `${rel(file)} timezone fallback`,
    wrong.length === 0,
    wrong.length === 0
      ? `${matches.length}x '${HOST_TZ}'`
      : `found ${JSON.stringify(wrong)}, want '${HOST_TZ}'`
  );
}

// --- checks 2 & 3: the bounce precedes the scan and the watchdog window -----
const bounceExpr = extract(read(ECOSYSTEM), /cron_restart:\s*'([^']+)'/, 'cron_restart', ECOSYSTEM);
const scanExpr = extract(read(OUTREACH), /const DEFAULT_CRON = '([^']+)'/, 'DEFAULT_CRON', OUTREACH);
const watchdogExpr = extract(read(WATCHDOG), /const DEFAULT_CRON = '([^']+)'/, 'DEFAULT_CRON', WATCHDOG);

const bounce = minutesOfDay(bounceExpr, 'pm2 cron_restart');
const scan = minutesOfDay(scanExpr, 'outreach DEFAULT_CRON');

// '*/5 9-21 * * *' -> the hour field '9-21' opens at 09:00.
const watchdogHourField = watchdogExpr.trim().split(/\s+/)[1];
if (!/^\d{1,2}-\d{1,2}$/.test(watchdogHourField)) {
  throw new Error(`watchdog cron '${watchdogExpr}' hour field '${watchdogHourField}' is not an H-H range`);
}
const watchdogOpens = Number(watchdogHourField.split('-')[0]) * 60;

console.log('');
console.log(`pm2 bounce      ${bounceExpr.padEnd(16)} ${fmt(bounce)} laptop-local`);
console.log(`outreach scan   ${scanExpr.padEnd(16)} ${fmt(scan)} scheduler-tz`);
console.log(`watchdog opens  ${watchdogExpr.padEnd(16)} ${fmt(watchdogOpens)} scheduler-tz`);
console.log('');

checkThat('pm2 bounce precedes the outreach scan', bounce < scan, `${fmt(bounce)} < ${fmt(scan)}`);
checkThat('pm2 bounce precedes the watchdog window', bounce < watchdogOpens, `${fmt(bounce)} < ${fmt(watchdogOpens)}`);

console.log('');
if (failures) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
pass('all schedule invariants hold');
process.exit(0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/check-bounce-precedes-scan.js`

Expected: exit code `1` with **seven** failures — five timezone failures, one per scheduler file (`monthly-scheduler.ts` reports a single line listing both of its occurrences), plus both timing checks, because the bounce is at 22:00 and the scan at 09:00:

```
FAIL  src/scheduler/outreach-scheduler.ts timezone fallback — found ["Asia/Kuala_Lumpur"], want 'Asia/Phnom_Penh'
...
FAIL  pm2 bounce precedes the outreach scan — 22:00 < 09:00
FAIL  pm2 bounce precedes the watchdog window — 22:00 < 09:00
```

If it instead throws `Could not find ...`, a regex has drifted from the source — fix the regex, not the source.

- [ ] **Step 3: Commit the failing check**

```bash
git add scripts/check-bounce-precedes-scan.js
git commit -m "test(scheduler): guard bounce-before-scan and Cambodia tz invariants

Fails against current config (bounce 22:00 vs scan 09:00, KL fallbacks).
Tasks 2 and 3 make it pass."
```

---

### Task 2: Move the pm2 bounce to 08:30

**Files:**
- Modify: `scripts/telegram-worker/ecosystem.config.js:26-27`
- Modify: `scripts/telegram-worker/README.md:90-91,105-108`
- Modify: `OUTREACH_RUNBOOK.md:135-137`

**Interfaces:**
- Consumes: `scripts/check-bounce-precedes-scan.js` from Task 1.
- Produces: `cron_restart: '30 8 * * *'` in `ecosystem.config.js`. Task 3 does not depend on this.

- [ ] **Step 1: Change the cron_restart**

In `scripts/telegram-worker/ecosystem.config.js`, replace this line:

```js
  cron_restart: '0 22 * * *', // nightly bounce at 10pm laptop-LOCAL time
```

with:

```js
  // Daily pre-run bounce at 08:30 laptop-LOCAL time (pm2's cron_restart has no
  // timezone option). The outreach scan drafts the day's batch at 09:00
  // Cambodia — the same clock, since the laptop is UTC+7 — so this hands each
  // day's work a fresh process 30 min ahead of it. Kept strictly before 09:00
  // on purpose: that is when the heartbeat-watchdog window opens, and a restart
  // inside it can raise a false worker-offline alert.
  // Guarded by scripts/check-bounce-precedes-scan.js.
  cron_restart: '30 8 * * *',
```

- [ ] **Step 2: Run the check to verify both timing assertions now pass**

Run: `node scripts/check-bounce-precedes-scan.js`

Expected: still exit `1` (the five timezone checks are Task 3's job), but the last two lines now read:

```
PASS  pm2 bounce precedes the outreach scan — 08:30 < 09:00
PASS  pm2 bounce precedes the watchdog window — 08:30 < 09:00
```

- [ ] **Step 3: Update the worker README**

In `scripts/telegram-worker/README.md`, replace lines 90-91:

```
For an unattended laptop, run it under **pm2** instead so it auto-restarts on
crash and bounces nightly. See "Run under pm2" below.
```

with:

```
For an unattended laptop, run it under **pm2** instead so it auto-restarts on
crash and bounces each morning before the day's scan. See "Run under pm2" below.
```

Then replace lines 105-108:

```
`ecosystem.config.js` defines TWO pm2 apps — `outreach-worker-company` and
`outreach-worker-personal` — one per sending number. pm2 auto-restarts each on
crash and bounces them nightly at 10pm (laptop-local time) via
`cron_restart: '0 22 * * *'`.
```

with:

```
`ecosystem.config.js` defines TWO pm2 apps — `outreach-worker-company` and
`outreach-worker-personal` — one per sending number. pm2 auto-restarts each on
crash and bounces them daily at 08:30 laptop-local via
`cron_restart: '30 8 * * *'` — 30 minutes ahead of the 09:00 Cambodia outreach
scan, so each day's batch is drafted for a freshly restarted worker.

Editing `cron_restart` in the file is **not** enough on its own: pm2 serves the
schedule from its saved dump, so the change only takes after
`pm2 delete ecosystem.config.js && pm2 start ecosystem.config.js && pm2 save`.
```

- [ ] **Step 4: Update the runbook**

In `OUTREACH_RUNBOOK.md`, replace lines 135-137:

```
restarts each on crash and bounces them nightly at **10pm laptop-local**
(`cron_restart: '0 22 * * *'`). Commands below use `<app>` — substitute either
app name, or omit it to act on all.
```

with:

```
restarts each on crash and bounces them daily at **08:30 laptop-local**
(`cron_restart: '30 8 * * *'`) — 30 minutes ahead of the 09:00 Cambodia outreach
scan, and before the watchdog window opens at 09:00 so the restart's heartbeat
gap can't raise a false `worker-offline` alert. A sleeping laptop simply misses
the bounce; pm2 does not catch up a missed `cron_restart`, and the worker still
serves the batch because it polls `/claim` every 60s regardless of process age.

Changing that schedule needs more than a file edit — pm2 reads `cron_restart`
from its saved dump, so run
`pm2 delete ecosystem.config.js && pm2 start ecosystem.config.js && pm2 save`
after editing. `node scripts/check-bounce-precedes-scan.js` asserts the bounce
still precedes the scan.

Commands below use `<app>` — substitute either app name, or omit it to act on
all.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/telegram-worker/ecosystem.config.js scripts/telegram-worker/README.md OUTREACH_RUNBOOK.md
git commit -m "fix(worker): bounce pm2 workers at 08:30, 30 min before the scan

Was 22:00 — 11 hours after the batch it should prepare for. 08:30 also sits
before the 09:00 watchdog window, so the restart gap can't false-alarm."
```

---

### Task 3: Flip every scheduler to Cambodia time

Six source edits plus `.env` and the doc samples. The hardcoded fallback matters as much as the env var: a `Asia/Kuala_Lumpur` default silently reasserts the bug anywhere the env var is missing, which is how the scan came to run at 08:00.

**Files:**
- Modify: `src/scheduler/outreach-scheduler.ts:57`
- Modify: `src/scheduler/heartbeat-watchdog-scheduler.ts:31`
- Modify: `src/scheduler/promise-scheduler.ts:26`
- Modify: `src/scheduler/monthly-scheduler.ts:76,80`
- Modify: `src/ad-scanner/ad-scanner-scheduler.ts:38`
- Modify: `.env:8` (gitignored — do not `git add`)
- Modify: `OUTREACH_RUNBOOK.md:199,278`
- Modify: `COMMANDS.md:240`
- Modify: `RAILWAY_DEPLOYMENT.md:39`

**Interfaces:**
- Consumes: `scripts/check-bounce-precedes-scan.js` from Task 1.
- Produces: no new symbols. Every `process.env.TIMEZONE || '...'` expression in the five scheduler files resolves to `'Asia/Phnom_Penh'`.

- [ ] **Step 1: Replace the fallback in all five scheduler files**

In each file below, replace every occurrence of the string `Asia/Kuala_Lumpur` with `Asia/Phnom_Penh`. The surrounding expression is unchanged — only the quoted literal moves.

| File | Occurrences | Line(s) |
|---|---|---|
| `src/scheduler/outreach-scheduler.ts` | 1 | 57 |
| `src/scheduler/heartbeat-watchdog-scheduler.ts` | 1 | 31 |
| `src/scheduler/promise-scheduler.ts` | 1 | 26 |
| `src/scheduler/monthly-scheduler.ts` | **2** | 76, 80 |
| `src/ad-scanner/ad-scanner-scheduler.ts` | 1 | 38 |

So, for example, `src/scheduler/outreach-scheduler.ts:57` goes from:

```ts
    const tz = process.env.TIMEZONE || 'Asia/Kuala_Lumpur';
```

to:

```ts
    const tz = process.env.TIMEZONE || 'Asia/Phnom_Penh';
```

and `src/scheduler/monthly-scheduler.ts:80` — the one that is easy to miss, because it is a log line rather than a cron option — goes from:

```ts
    Logger.info(`Timezone: ${process.env.TIMEZONE || 'Asia/Kuala_Lumpur'}`);
```

to:

```ts
    Logger.info(`Timezone: ${process.env.TIMEZONE || 'Asia/Phnom_Penh'}`);
```

Do **not** touch `src/utils/time.ts` — it has no `Asia/Kuala_Lumpur` in it, and its `Asia/Phnom_Penh` / `UTC` fallbacks are already correct.

- [ ] **Step 2: Verify no scheduler still references Kuala Lumpur**

Run: `git grep -n "Kuala_Lumpur" -- src/`

Expected: no output (exit code 1 from grep, which is the success case here). If anything prints, fix that line and re-run.

- [ ] **Step 3: Run the guard — it should now pass completely**

Run: `node scripts/check-bounce-precedes-scan.js`

Expected: exit `0`, ending with `PASS  all schedule invariants hold`. All five timezone lines plus both timing lines read `PASS`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: no output, exit `0`. This is the only static gate the repo has — there is no test framework.

- [ ] **Step 5: Update `.env` (local only, gitignored)**

Change line 8 of `.env` from:

```
TIMEZONE=Asia/Kuala_Lumpur
```

to:

```
TIMEZONE=Asia/Phnom_Penh
```

Leave line 9 (`REPORT_TIMEZONE=Asia/Phnom_Penh`) alone. Do not `git add .env`.

- [ ] **Step 6: Update the two runbook env tables**

In `OUTREACH_RUNBOOK.md`, replace line 199:

```
| `TIMEZONE` | `Asia/Kuala_Lumpur` | Timezone the watchdog cron runs in |
```

with:

```
| `TIMEZONE` | `Asia/Phnom_Penh` | Timezone the watchdog cron runs in |
```

and replace line 278:

```
| `TIMEZONE` | `Asia/Kuala_Lumpur` | Cron timezone |
```

with:

```
| `TIMEZONE` | `Asia/Phnom_Penh` | Cron timezone. Cambodia local — `0 9 * * *` means 09:00 in Phnom Penh. Setting this to a UTC+8 zone silently moves every scan an hour early. |
```

- [ ] **Step 7: Update the two env samples**

In `COMMANDS.md`, replace line 240:

```
TIMEZONE=Asia/Kuala_Lumpur              # Timezone for scheduling
```

with:

```
TIMEZONE=Asia/Phnom_Penh                # Timezone for scheduling (Cambodia)
```

In `RAILWAY_DEPLOYMENT.md`, replace line 39:

```
TIMEZONE=Asia/Kuala_Lumpur
```

with:

```
TIMEZONE=Asia/Phnom_Penh
```

- [ ] **Step 8: Commit**

```bash
git add src/scheduler/outreach-scheduler.ts src/scheduler/heartbeat-watchdog-scheduler.ts src/scheduler/promise-scheduler.ts src/scheduler/monthly-scheduler.ts src/ad-scanner/ad-scanner-scheduler.ts OUTREACH_RUNBOOK.md COMMANDS.md RAILWAY_DEPLOYMENT.md
git commit -m "fix(scheduler): run every cron on Cambodia time, not Kuala Lumpur

TIMEZONE=Asia/Kuala_Lumpur (UTC+8) made the outreach scan's '0 9 * * *' fire
at 08:00 Cambodia. Flips the env var and all six hardcoded fallbacks to
Asia/Phnom_Penh so each cron means what it says locally.

Shifts four other schedulers one hour later in absolute terms, onto their
stated Cambodia hour: promise reminder 08:00, ad scanner 09:30, monthly
rollup 00:01, watchdog window 09:00-21:55."
```

---

## Operator handoff (not code — must be done by the user)

Neither step is reachable from the repo, and skipping either leaves the committed change inert. Report both to the user on completion.

- [ ] **Railway:** set `TIMEZONE=Asia/Phnom_Penh` on the API service and redeploy. The `.env` edit governs local dev only; the 09:00 scan runs on Railway against *its* env var, which wins over the code fallback wherever it is set. Until this is done the production scan stays at 08:00 Cambodia.
- [ ] **pm2 (laptop):** reload the process definition, because pm2 serves `cron_restart` from its saved dump rather than the file:
  ```
  pm2 delete scripts/telegram-worker/ecosystem.config.js
  pm2 start  scripts/telegram-worker/ecosystem.config.js
  pm2 save
  ```

### Post-deploy confirmation

- Railway logs show `Outreach scheduler started (cron='0 9 * * *', tz='Asia/Phnom_Penh')`.
- `pm2 describe outreach-worker-company` shows `cron_restart` as `30 8 * * *` (repeat for `outreach-worker-personal`).
