# Outreach Daily-Cap Delivery Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an outreach worker delivers its 15th message of the day, DM Kasing's personal Telegram chat with a "session complete, 15/15 delivered" notification — separate from the existing boss/dev audit group.

**Architecture:** Reuse the existing throttled alert pipeline (`outreach-alerts.ts` → `worker-alert` API route → `worker.ts`'s `postAlert`) that already handles `worker-offline`/`session-expired`/`worker-fatal`. Add one new `AlertKind` (`daily-cap-reached`), fire it from an edge-trigger in the worker's send loop the moment `sentToday` reaches `DAILY_CAP`, and route it to the existing `WORKER_ALERT_CHAT_ID` env var (already used by the heartbeat watchdog to DM the operator) — but, unlike the other worker-level kinds, drop it rather than falling back to `AUDIT_CHAT_ID` when that var is unset, since this report must never reach the boss/dev group.

**Tech Stack:** TypeScript, Express, Telegraf (via `notifyOutreachFailure`'s injected sender), gramjs worker script. No test framework is configured in this repo — verification is `npm run typecheck` per task plus one manual end-to-end task that sends a real Telegram message.

## Global Constraints

- **Verification model:** this repo has NO test runner (no jest/vitest/mocha). Per-task verification is `npm run typecheck` (runs `tsc --noEmit`) plus the manual check described in the task. Do not add a test framework.
- **Env var:** reuse `WORKER_ALERT_CHAT_ID` (already documented at `OUTREACH_RUNBOOK.md:210`). Do **not** add a new `OWNER_CHAT_ID`/`PERSONAL_CHAT_ID` var — that would duplicate config pointing at the same chat.
- **Fallback behavior:** for `daily-cap-reached` specifically, an unset `WORKER_ALERT_CHAT_ID` means **drop the alert with a logged warning** — never fall back to `AUDIT_CHAT_ID`/`REPORT_CHAT_ID`. This is the opposite of how `worker-offline`/`session-expired`/`worker-fatal` behave today (they fall back on purpose) — do not change their behavior.
- **Trigger:** edge-triggered exactly once per org per day, the moment `workerState.sentToday` reaches `DAILY_CAP` inside the existing send loop. Do not add a new poll/cron for this.
- **Message content:** count + status only. No per-customer breakdown, no failure/skip detail — that already exists elsewhere.
- **Work on branch `feature/outreach-multi-org`.** Do **not** commit to `main`.
- **`.env` is gitignored** — edit it for local testing, but never `git add` it.
- Spec: `docs/superpowers/specs/2026-08-07-outreach-cap-delivery-report-design.md`. **After Task 4's manual verification passes, delete this spec file and commit the deletion** — Kasing explicitly asked for it to be cleared once the feature is confirmed working (this is a one-off request for this file, not a repo-wide convention — the other files in `docs/superpowers/specs/` stay).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/outreach/outreach-alerts.ts` | Modify | Add `daily-cap-reached` to `AlertKind`, its message template, and its throttle registration. |
| `src/api/outreach-routes.ts` | Modify:258-274 | `worker-alert` route: route `daily-cap-reached` to `WORKER_ALERT_CHAT_ID`, drop-not-fallback when unset. |
| `scripts/telegram-worker/worker.ts` | Modify:588-592 | Fire `postAlert('daily-cap-reached', ...)` the moment `sentToday` reaches `DAILY_CAP`. |
| `OUTREACH_RUNBOOK.md` | Modify:210 | Extend the `WORKER_ALERT_CHAT_ID` row to mention its second use. |
| `docs/superpowers/specs/2026-08-07-outreach-cap-delivery-report-design.md` | Delete (Task 4) | Spec doc — removed once the feature is verified working, per Kasing's request. |

---

### Task 1: New `daily-cap-reached` alert kind

**Files:**
- Modify: `src/outreach/outreach-alerts.ts`

**Interfaces:**
- Consumes: nothing new (uses the existing `notifyOutreachFailure`/`FailureContext`/`AlertKind` shapes already in this file).
- Produces: `AlertKind` now includes `'daily-cap-reached'`. Calling `notifyOutreachFailure(null, 'daily-cap-reached', { reason: '15/15', org: 'company' })` sends (subject to throttle) the text:
  ```
  ✅ *Outreach delivery cap reached* (company)

  Delivered: 15/15 today.
  Resumes after UTC midnight reset.
  ```
  Tasks 2 and 3 depend on this `AlertKind` member existing (Task 2's `kind === 'daily-cap-reached'` comparison and Task 3's `postAlert('daily-cap-reached', ...)` call both need it in the union to typecheck cleanly).

- [ ] **Step 1: Add the alert kind to the union**

In `src/outreach/outreach-alerts.ts`, replace:

```typescript
export type AlertKind =
  | 'mark-failed'
  | 'transient-requeue'
  | 'lease-expired'
  | 'worker-offline'
  | 'session-expired'
  | 'worker-fatal';
```

with:

```typescript
export type AlertKind =
  | 'mark-failed'
  | 'transient-requeue'
  | 'lease-expired'
  | 'worker-offline'
  | 'session-expired'
  | 'worker-fatal'
  | 'daily-cap-reached';
```

- [ ] **Step 2: Register it as a worker-level (per-org-throttled) kind**

In the same file, replace:

```typescript
const WORKER_LEVEL_KINDS = new Set<AlertKind>(['worker-offline', 'session-expired', 'worker-fatal']);
```

with:

```typescript
const WORKER_LEVEL_KINDS = new Set<AlertKind>(['worker-offline', 'session-expired', 'worker-fatal', 'daily-cap-reached']);
```

This gives it the same 30-minute per-`(kind, org)` throttle as the other worker-level kinds — a safety net in case the edge-trigger in Task 3 ever fires more than once for the same org on the same day.

- [ ] **Step 3: Add its message template**

In the same file, inside `formatProposalAlert`, replace:

```typescript
    case 'worker-fatal':
      lines.push(`🚨 *Outreach worker fatal error*${orgTag}`);
      break;
  }
```

with:

```typescript
    case 'worker-fatal':
      lines.push(`🚨 *Outreach worker fatal error*${orgTag}`);
      break;
    case 'daily-cap-reached': {
      lines.push(`✅ *Outreach delivery cap reached*${orgTag}`);
      lines.push('');
      lines.push(`Delivered: ${ctx.reason || 'cap reached'} today.`);
      lines.push('Resumes after UTC midnight reset.');
      return lines.join('\n');
    }
  }
```

This `return` inside the `case` is deliberate: every other kind falls through to the shared `if (proposal) {...} else {...}` tail below the switch, which appends a generic `Reason:`/`Worker:`/CRM-link footer meant for failure alerts. A "session complete" ping doesn't need that footer, so this case builds its full message and returns early instead.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no output. `formatProposalAlert` is only called with `proposal: null` for worker-level kinds elsewhere in the file, so the early return changes nothing about existing call sites.

- [ ] **Step 5: Commit**

```bash
git add src/outreach/outreach-alerts.ts
git commit -m "$(cat <<'EOF'
feat(outreach): add daily-cap-reached alert kind

Worker-level kind, same 30-min per-org throttle as worker-offline/
session-expired/worker-fatal. Own message template (count + status,
no failure-alert footer) since this is a routine ping, not a failure.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Route `daily-cap-reached` to `WORKER_ALERT_CHAT_ID`, dropping if unset

**Files:**
- Modify: `src/api/outreach-routes.ts:258-274`

**Interfaces:**
- Consumes: `AlertKind` (now including `'daily-cap-reached'`) and `notifyOutreachFailure` from Task 1.
- Produces: no new symbols. `POST /crm/api/outreach/worker-alert` with `{ kind: 'daily-cap-reached', reason, worker_id }` now DMs `WORKER_ALERT_CHAT_ID` (or drops with a warning if unset) instead of going through the default `AUDIT_CHAT_ID`/`REPORT_CHAT_ID` path. Every other `kind` is completely unchanged. Task 4 exercises this route directly.

- [ ] **Step 1: Special-case `daily-cap-reached` before the generic alert call**

In `src/api/outreach-routes.ts`, replace the `worker-alert` route body:

```typescript
router.post('/worker-alert', express.json(), agentOnly, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const kind = (body.kind as AlertKind) || 'worker-fatal';
    const reason = typeof body.reason === 'string' ? body.reason : 'unspecified';
    const workerId = typeof body.worker_id === 'string' ? body.worker_id : undefined;
    const org = resolveOrg(req);
    await notifyOutreachFailure(null, kind, { reason, worker_id: workerId, org });
    if (kind === 'session-expired' || kind === 'worker-fatal') {
      await new OutreachWorkerStateRepository().setLastError(org, `${kind}: ${reason}`);
    }
    res.json({ ok: true });
  } catch (err) {
    Logger.error('outreach worker-alert failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

with:

```typescript
router.post('/worker-alert', express.json(), agentOnly, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const kind = (body.kind as AlertKind) || 'worker-fatal';
    const reason = typeof body.reason === 'string' ? body.reason : 'unspecified';
    const workerId = typeof body.worker_id === 'string' ? body.worker_id : undefined;
    const org = resolveOrg(req);

    if (kind === 'daily-cap-reached') {
      // Personal DM only — never the boss/dev audit group. Unlike the other
      // worker-level kinds (which fall back to AUDIT_CHAT_ID on purpose so a
      // real failure is never silently dropped), a routine cap-reached ping
      // with nowhere configured to go should just be dropped.
      const dmChatId = process.env.WORKER_ALERT_CHAT_ID;
      if (!dmChatId) {
        Logger.warn('outreach worker-alert: WORKER_ALERT_CHAT_ID not set, dropping daily-cap-reached alert');
        res.json({ ok: true });
        return;
      }
      await notifyOutreachFailure(null, kind, { reason, worker_id: workerId, org, chatId: dmChatId });
      res.json({ ok: true });
      return;
    }

    await notifyOutreachFailure(null, kind, { reason, worker_id: workerId, org });
    if (kind === 'session-expired' || kind === 'worker-fatal') {
      await new OutreachWorkerStateRepository().setLastError(org, `${kind}: ${reason}`);
    }
    res.json({ ok: true });
  } catch (err) {
    Logger.error('outreach worker-alert failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. `kind === 'daily-cap-reached'` only typechecks because Task 1 added it to the `AlertKind` union — if Task 1 were skipped, this line would fail with "This comparison appears to be unintentional because the types have no overlap."

- [ ] **Step 3: Commit**

```bash
git add src/api/outreach-routes.ts
git commit -m "$(cat <<'EOF'
feat(outreach): DM daily-cap-reached to WORKER_ALERT_CHAT_ID, not the audit group

Reuses the existing operator-DM env var (already used by the heartbeat
watchdog) instead of adding a new one. Drops the alert if the var is
unset rather than falling back to AUDIT_CHAT_ID like the other
worker-level kinds do — this report must never reach the boss/dev group.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Fire the alert from the worker's send loop

**Files:**
- Modify: `scripts/telegram-worker/worker.ts:588-592`

**Interfaces:**
- Consumes: `postAlert(kind: string, reason: string): Promise<void>` (already defined in this file at line 181) and the `'daily-cap-reached'` kind from Task 1/2.
- Produces: no new symbols. After this change, the worker calls `postAlert('daily-cap-reached', '15/15')` exactly once, at the instant the 15th delivery of the day succeeds. Task 4 verifies this end to end.

- [ ] **Step 1: Add the edge-trigger after a successful send**

In `scripts/telegram-worker/worker.ts`, replace:

```typescript
    if (result.ok) {
      await markSent(proposal._id);
      workerState.sentToday++;
      workerState.lastError = null;
      console.log(`  ✓ sent (${workerState.sentToday}/${DAILY_CAP} today)`);
    } else {
```

with:

```typescript
    if (result.ok) {
      await markSent(proposal._id);
      workerState.sentToday++;
      workerState.lastError = null;
      console.log(`  ✓ sent (${workerState.sentToday}/${DAILY_CAP} today)`);
      if (workerState.sentToday === DAILY_CAP) {
        await postAlert('daily-cap-reached', `${workerState.sentToday}/${DAILY_CAP}`);
      }
    } else {
```

The `===` (not `>=`) is deliberate: it fires exactly once per day per org, the moment the count reaches the cap, instead of on every later iteration where the loop is just idling at `sentToday >= DAILY_CAP` (line 560).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. `postAlert`'s `kind` parameter is a plain `string`, so this compiles regardless of the `AlertKind` union — but it only produces a labeled, formatted message server-side because Tasks 1–2 taught the server what `'daily-cap-reached'` means.

- [ ] **Step 3: Commit**

```bash
git add scripts/telegram-worker/worker.ts
git commit -m "$(cat <<'EOF'
feat(worker): alert once when the daily delivery cap is reached

Previously just console.log'd and idled. Fires on the sentToday ===
DAILY_CAP edge (once per org per day), not on every subsequent poll.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Manual end-to-end verification, runbook doc, and spec cleanup

**Files:**
- Modify: `OUTREACH_RUNBOOK.md:210`
- Delete: `docs/superpowers/specs/2026-08-07-outreach-cap-delivery-report-design.md`

This task has no automated check — it sends a real Telegram message. Do it against local dev first; only touch Railway/pm2 if you want the change live for the actual laptop worker before its next scheduled run.

- [ ] **Step 1: Confirm `WORKER_ALERT_CHAT_ID` is set to Kasing's chat**

Check the root `.env` (the one `src/index.ts` loads, not `scripts/telegram-worker/.env`):

```bash
grep WORKER_ALERT_CHAT_ID .env
```

If it's missing or wrong, add/fix it:

```
WORKER_ALERT_CHAT_ID=1450060367
```

Do not `git add .env` — it's gitignored.

- [ ] **Step 2: Start the app locally**

Run: `npm run dev`

Expected: it boots and logs the outreach scheduler/watchdog startup lines (same as any normal local run). Leave it running for the next step.

- [ ] **Step 3: Fire the alert route directly and confirm the DM arrives**

In a second terminal, read the worker's agent token (do not paste its value anywhere else):

```bash
grep AGENT_TOKEN scripts/telegram-worker/.env
```

Then, substituting that value for `<AGENT_TOKEN>`:

```bash
curl -s -X POST http://localhost:3001/crm/api/outreach/worker-alert \
  -H "Authorization: Bearer <AGENT_TOKEN>" \
  -H "X-Org-Id: company" \
  -H "Content-Type: application/json" \
  -d '{"kind":"daily-cap-reached","reason":"15/15","worker_id":"manual-test"}'
```

Expected: the curl prints `{"ok":true}`, and within a few seconds Kasing's personal Telegram chat (`1450060367`) receives:

```
✅ Outreach delivery cap reached (company)

Delivered: 15/15 today.
Resumes after UTC midnight reset.
```

Confirm the message did **not** also appear in the boss/dev audit group.

- [ ] **Step 4: Confirm the drop-if-unset path**

Stop the dev server (`Ctrl+C`), temporarily comment out or remove `WORKER_ALERT_CHAT_ID` from `.env`, restart `npm run dev`, and repeat the same `curl` call from Step 3.

Expected: curl still prints `{"ok":true}` (the route doesn't error), no Telegram message arrives anywhere, and the server log shows:

```
outreach worker-alert: WORKER_ALERT_CHAT_ID not set, dropping daily-cap-reached alert
```

Restore `WORKER_ALERT_CHAT_ID` in `.env` afterward.

- [ ] **Step 5: Update the runbook**

In `OUTREACH_RUNBOOK.md`, replace line 210:

```
| `WORKER_ALERT_CHAT_ID` | falls back to `AUDIT_CHAT_ID` | DM target (operator's numeric Telegram id; DM the bot once first) |
```

with:

```
| `WORKER_ALERT_CHAT_ID` | falls back to `AUDIT_CHAT_ID` for `worker-offline`/`session-expired`/`worker-fatal`; **dropped (not sent) for `daily-cap-reached`** if unset | DM target (operator's numeric Telegram id; DM the bot once first). Also where the "15/15 delivered" daily-cap alert goes — see `scripts/telegram-worker/worker.ts`'s send loop. |
```

- [ ] **Step 6: Commit the runbook update**

```bash
git add OUTREACH_RUNBOOK.md
git commit -m "$(cat <<'EOF'
docs(outreach): document daily-cap-reached use of WORKER_ALERT_CHAT_ID

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Delete the spec doc, per Kasing's request**

Only after Steps 3-4 above have both been confirmed working:

```bash
git rm docs/superpowers/specs/2026-08-07-outreach-cap-delivery-report-design.md
git commit -m "$(cat <<'EOF'
chore: remove outreach-cap-delivery-report spec doc

Feature verified working end to end; Kasing asked for the spec file
to be cleared once done. The implementation plan
(docs/superpowers/plans/2026-08-07-outreach-cap-delivery-report.md)
stays.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Operator handoff (not code — must be done by Kasing)

Neither step is reachable from the repo, and skipping either means the *real* laptop worker (as opposed to local dev) never gets this behavior.

- [ ] **Railway:** confirm `WORKER_ALERT_CHAT_ID=1450060367` is set on the API service (the one running `src/index.ts` — same service that already needs it for the heartbeat watchdog, if that's enabled there). If it's only in local `.env`, production alerts will be dropped, not misrouted — check the server logs for the "not set, dropping" warning if the DM doesn't arrive in production.
- [ ] **pm2 (laptop worker):** no `ecosystem.config.js` change is needed — `DAILY_CAP` and the alert-firing logic live in `worker.ts` itself, which pm2 already runs from source via `ts-node`/the built `dist`. A normal `pm2 restart` (or the existing 08:30 daily bounce) picks up Task 3's change; no new env var is needed on the worker side.

### Post-deploy confirmation

- The next time a worker's `sentToday` reaches 15 in production, Kasing's personal chat (`1450060367`) receives the "delivery cap reached" DM, and the boss/dev audit group does not.
