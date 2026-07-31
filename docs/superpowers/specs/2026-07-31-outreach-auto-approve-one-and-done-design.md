# Outreach: auto-approve toggle, one-and-done contact rule, failure reclassification

**Date:** 2026-07-31
**Branch:** `feature/outreach-multi-org`
**Status:** approved design, pending implementation plan

## Problem

Four operational problems with the outreach pipeline, reported from live use:

1. **Approval is a manual click.** Every proposal waits for a human to press
   approve on `/crm/outreach`. The operator wants an *option* to let the day's
   batch approve itself, without removing the manual mode.
2. **Failure accounting is wrong.** Privacy-blocked numbers (recipient's "find me
   by number" is restricted) are retried 3× over ~180 days even though they are
   permanently unreachable, while transient failures — overwhelmingly a pm2
   crash or worker restart, where the message never left — are recorded and
   silently dropped back into the pool with no alert.
3. **Numbers get re-contacted.** The 45-day stale re-scan re-selects numbers that
   were already messaged, so a lead can be DM'd repeatedly. The operator's rule is
   one outreach per number, ever.
4. **A phone list can't be imported.** A supplied `.xlsx` of 100 numbers
   (97 unique) uses a `Phone Number` column, which the importer does not
   recognise; it falls through to the QuickBook free-text parser and mangles.

## Non-goals

- Raising the delivery cap. It stays at **15 successful sends/day per workspace**.
- Re-enabling AI drafting. The static Khmer template stays.
- Any change to ingestion, daily reports, or the inbound-reply path.
- A manual "un-close" UI for contacted numbers. One-and-done is final.

---

## 1. Per-workspace Manual ⇄ Auto approve toggle

**Storage.** `outreach_worker_state` is already one document per org
(`_id: 'company' | 'personal'`) and already carries the `paused` flag. Add a
sibling field:

```ts
auto_approve: boolean   // default false = manual
```

No migration needed beyond a default on read — an absent field reads as `false`,
which is today's behaviour.

**Repository.** `outreach-worker-state-repository.ts` gains
`setAutoApprove(orgId, on)`. Reads come from the existing `getState(orgId)`.

**API.** `POST /crm/api/outreach/auto-approve` mirroring the existing `/pause`
endpoint one-for-one: body `{ enabled?: boolean }` (absent = toggle), org
resolved by `resolveOrg(req)`, response `{ org, auto_approve }`. The org also
surfaces in the existing `/worker-status` payload so the dashboard can render
current state.

**UI.** A switch on `/crm/outreach` beside the pause control, labelled with the
active workspace name so it is visually unambiguous that the switch belongs to
*this* sending number only. Company and personal are independent: one may run on
auto while the other is reviewed by hand.

**Dead code note.** `src/outreach/auto-approve-gate.ts` and the
`OUTREACH_AUTO_APPROVE` env var gated auto-approval of *AI-generated* drafts.
AI drafting is disabled, so that path is already dead. The toggle supersedes it.
The file is left untouched — removing it is unrelated cleanup.

---

## 2. The 9AM scan: top up to 20 outstanding

**Timing correction.** The scan runs server-side (Railway), not on the operator's
laptop. Drafting happens at 9AM regardless of whether the laptop is open; the
laptop only governs *sending*. A laptop opening at 09:30 finds a queue already
staged.

**Behaviour change — top-up, not append.** Today the scan drafts a flat batch
(`DEFAULT_BATCH_LIMIT = 20`) with a separate 30/day budget. Replace with:

```
outstanding = count(status ∈ {pending, approved}) for this org
draft_count = max(0, 20 - outstanding)
```

The outstanding queue therefore never exceeds 20, and no backlog can accumulate.
This matters because drafting is 20/day while delivery is 15/day: without the
top-up rule the queue grows by the difference between 20 and (15 + privacy
attrition) every day, and with auto-approve on, nobody is reviewing the pile.

**Per-org.** `OutreachScheduler.runScan` currently calls `generateBatch` with no
`orgId`, defaulting to `company`. It must iterate `OUTREACH_ORGS` so the personal
workspace also gets a 9AM scan — otherwise the personal toggle is decorative.

**Approval status.** `generateBatch` currently takes `autoApprove` from the
caller. The scheduler now derives it per org from the toggle:

| Toggle | Proposal status | `approved_by` |
|---|---|---|
| Auto | `approved` | `auto-approve` |
| Manual | `pending` | `null` |

**Caps unchanged.** `DAILY_CAP` stays 15 (deliveries), `DAILY_ATTEMPT_CAP` stays
40 (ImportContacts lookups). The 20-vs-15 gap is deliberate headroom: privacy
failures do not consume a delivery slot under the two-cap model, so drafting 20
is what allows 15 to actually land.

**Retired.** `DEFAULT_DAILY_DRAFT_BUDGET` (30) and the `draftsToday` in-memory
counter are removed — the top-up rule makes them redundant, and an in-memory
counter is lost on every restart anyway.

---

## 3. Failure reclassification

`classifyFailure()` already sorts reasons into `privacy | invalid | transient`.
The classifier is correct; what happens next is not.

| Kind | Today | New |
|---|---|---|
| `privacy` | suppress, retry 3× at 60d intervals, then `exhausted` | **Closed permanently.** `next_retry_at: null`, no retry ever. Presented as *unreachable*, not as an actionable failure. |
| `invalid` | closed forever | unchanged |
| `transient` | recorded for visibility only; number silently re-enters the pool with no alert | **Proposal re-queued** — status flipped back to `approved` so the worker retries on its next loop — **and a Telegram alert fires** to the operator. |

**Why transient must re-queue.** A pm2 crash or lease expiry means the message
never reached the customer. Under the new one-and-done rule (§4), letting that
number fall through as "attempted" would burn its single lifetime contact on a
send that never happened.

**Bounded.** Transient re-queues are capped at **3 per proposal** via a
`transient_retries` counter on the proposal document. On the 4th, the proposal
goes to `failed` and stays there, with an alert. This prevents a genuinely
broken send from looping forever.

**Alerting** reuses `notifyOutreachFailure` with the existing
`WORKER_ALERT_CHAT_ID` override, the same mechanism the heartbeat watchdog uses.

**Removed.** `OutreachScheduler.runRetryScan()`, the `OUTREACH_RETRY_ENABLED`
env gate, and `OutreachSuppressionRepository.listForRetry` / `bumpRetry` /
`deferRetry` exist solely to re-touch privacy numbers on a 60-day cycle — which
the one-and-done rule forbids. They are deleted rather than left disabled, so a
future operator cannot re-enable a flag that would silently violate the rule.

---

## 4. One-and-done contact ledger

**Rule.** A phone number receives exactly one outreach, ever, per workspace.

**Mechanism.** Extend the existing `outreach_suppressions` collection with a new
kind rather than introducing a parallel collection:

```ts
export type SuppressionKind = 'privacy' | 'invalid' | 'transient' | 'contacted';
```

`contacted` joins `SUPPRESSING_KINDS`, so the existing
`getSuppressedPhones(orgId)` filter in `selectCandidates` enforces it with no new
query path. One collection, one `org_phone_unique` index, one page.

**Write point.** `POST /mark-sent` records a `contacted` suppression for the
phone, in the same handler that already bumps `deliveries_today`.

**Scope: per workspace.** Uniqueness stays `(org_id, customer_phone)`, matching
the existing index and the isolation model of the toggles. A number contacted by
the company account remains eligible for one contact by the personal account.

**Dedup window.** `hasRecentProposalForPhone` keeps its 14-day window for its
actual job — preventing a double-queue while a proposal is in flight. Permanence
comes from the ledger, not from that window.

**Backfill.** `scripts/backfill-contacted-ledger.js --confirm`:
1. For each org, scan `outreach_proposals` for `status: 'sent'` and upsert a
   `contacted` suppression per distinct phone.
2. Rewrite existing `privacy` records to the closed form (`next_retry_at: null`).
3. Report counts; make no writes without `--confirm`.

**Consequence to state plainly.** `DEFAULT_STALE_DAYS = 45` stops meaning
"re-DM after 45 days" and starts meaning "how old a lead must be before its
*first* contact". This is the intended change — the operator's judgement is that
re-DMing after 45 days is not worth it.

---

## 5. Phone-list import

**Current defect.** `POST /crm/api/import` treats a sheet as structured only if
a header cell equals exactly `phone`. The supplied file's header is
`Phone Number`, so it falls through to the QuickBook free-text branch and
`extractQuickBookRecord` mangles each row.

**Fix.**
- Recognise a phone column by alias: `phone`, `phone number`, `phone_number`,
  `phone no`, `tel`, `number`, `contact` (case- and space-insensitive).
- Ignore a leading index column (`no`, `no.`, `#`, `index`).
- Fall through to the QuickBook text parser **only** when no phone-ish column
  exists — the current behaviour becomes the explicit fallback rather than the
  default.

**Normalisation and dedup**, in order:
1. `toInternationalPhone` every value; drop anything failing `/^\+855\d{8,9}$/`.
2. Dedupe within the file (the supplied file: 100 rows → 97 unique).
3. Drop numbers already present in `leads_events` for the target org.
4. Drop numbers already in the contacted ledger for the target org.

**Insert shape.** Name, follower, page, destination all `null`. Date backdated
by `STALE_DAYS` (45) as the existing QuickBook branch already does, so imported
numbers are immediately eligible for the 9AM scan.

**Preview response** reports every bucket so the operator sees what happened:
`parsed`, `invalid_format`, `duplicate_in_file`, `already_in_db`,
`already_contacted`, `net_new`.

At 20 drafted/day mixed with the existing stale pool, 97 numbers is roughly a
week of outreach.

---

## Verification

The repository has no test framework (no `test` script, no Jest/Vitest). Adding
one is out of scope for this change. Verification follows the existing
`scripts/check-*.js` convention:

| Script | Asserts |
|---|---|
| `scripts/check-auto-approve-toggle.js` | Toggle persists per org; company and personal are independent; absent field reads `false`. |
| `scripts/check-scan-topup.js` | With N outstanding, the scan drafts exactly `20 - N`; drafts 0 when N ≥ 20; runs for both orgs. |
| `scripts/check-failure-routing.js` | Each classifier kind lands in the right terminal state; privacy has `next_retry_at: null`; transient re-queues at most 3× then fails. |
| `scripts/check-contacted-ledger.js` | `mark-sent` writes the record; a contacted phone is excluded from `selectCandidates`; the exclusion is per-org. |
| `scripts/check-import-aliases.js` | The supplied file parses to 97 numbers with correct bucket counts; a header-less QuickBook file still hits the fallback parser. |

Backfill is verified by a dry run (no `--confirm`) with counts compared against a
direct `outreach_proposals` aggregate before applying.

## Risks

- **Backfill is destructive to eligibility.** Once past sends are stamped
  `contacted`, those numbers are permanently out of the pool and there is no
  un-close UI by design. The dry run is the only checkpoint.
- **Auto mode removes the human gate.** With the toggle on, messages reach real
  customers with nobody reading them first. The pause flag remains the kill
  switch, and the daily cap of 15 bounds the blast radius.
- **Deleting the retry path is one-way.** Re-introducing 60-day privacy retries
  later means rewriting the deleted code.
