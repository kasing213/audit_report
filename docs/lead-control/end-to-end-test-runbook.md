# Lead Control end-to-end test runbook

## Purpose

Use this runbook to validate Lead Control from deployment controls through campaign forecasting, actual campaign data, Payment Tracker synchronization, attribution, cancellation reporting, audit history, and rollback. Run it first in a staging environment with sanitized data. Do not enable production writes until the boss signs the historical comparison gate.

Record every test as `Pass`, `Fail`, or `Blocked`, attach screenshots or API evidence, and record the application commit, database snapshot ID, tester, and Cambodia test date.

## Fixed test fixture

Use one campaign consistently so every tester can compare the same numbers.

| Field | Value |
| --- | --- |
| Page | `LC E2E Page` |
| Campaign | `September E2E Campaign` |
| Property/project | `September Heights` |
| Objective | `Qualified property visits` |
| Audience | `Phnom Penh buyers` |
| Active dates | `2026-09-01` through `2026-09-30` |
| Monthly budget | `$100.00` / `10000` cents |
| Maximum cost/message | `$1.50` / `150` cents |
| Message → phone | `30%` / `0.30` |
| Phone → visit | `50%` / `0.50` |
| Visit → booking | `20%` / `0.20` |
| Cancellation rate | `10%` / `0.10` |

Expected full-month forecast:

| Stage | Expected |
| --- | ---: |
| Messages | `66.7` |
| Valid phone leads | `20.0` |
| Completed visits | `10.0` |
| Gross bookings | `2.0` |
| Cancellations | `0.2` |
| Net bookings | `1.8` |

Reverse-control value: target `10.0` net bookings must require `$555.56` (`55556` cents).

Mid-month pacing fixture for `2026-09-15`:

- Planned spend-to-date: `$50.00`.
- Actual spend `$45.00`: `$5.00` behind plan.
- Spend-adjusted expectations at `$45.00`: `30.0` messages, `9.0` phones, `4.5` visits, `0.9` gross bookings, `0.1` cancellations, and `0.8` net bookings after one-decimal display rounding.

## Evidence sheet

Create one row per test ID:

| Test ID | Tester/date | Result | Evidence link | Defect ID/notes |
| --- | --- | --- | --- | --- |
| Example: `LC-01` |  |  |  |  |

Any failure in authorization, immutable baselines, Payment Tracker read-only scope, frozen attribution, raw-data preservation, or audit logging is a release blocker.

## Phase 0 — environment and automated gates

### LC-01: Record deployment identity and backup

1. Record the exact Git commit under test.
2. Create and verify a restorable Audit Sales database snapshot.
3. Confirm the environment uses `Asia/Phnom_Penh` for business reporting.
4. Confirm no real customer phone, credential, token, or connection string appears in the evidence package.

Expected: commit and snapshot IDs are recorded; restore verification has an owner and timestamp.

### LC-02: Run the automated suite

Run from the repository root:

```powershell
npm ci
npm test
npm run typecheck:test
npm run typecheck
npm run build
npm run verify:lead-control-indexes
git diff --check
```

Expected:

- All tests pass; the current branch baseline is `144` tests.
- Both typechecks and the build pass.
- Index verification reports all `20` required indexes present against the target Audit Sales database.
- The worktree has no unexpected changes.

Stop if index verification fails. It compares names, ordered keys, `unique`, `sparse`, and partial filters; a same-named unsafe definition also fails. Do not enable writes until the reported definitions are repaired and the command passes.

### LC-03: Verify safe defaults

Deploy with:

```text
LEAD_CONTROL_WRITES_ENABLED=false
LEAD_CONTROL_SYNC_ENABLED=false
LEAD_CONTROL_SYNC_INTERVAL_MINUTES=15
```

Expected: the application starts; no Lead Control source connection is opened; no Lead Control sync cron is registered; the page shows `Read-only comparison mode`.

## Phase 1 — access and read-only comparison

### LC-04: Role permissions

Test the same `/lead-control` URL with each existing Audit Sales role.

| Role | Expected |
| --- | --- |
| `developer` | Page opens |
| `manager` | Page opens |
| `agent` | `403`; navigation item hidden |
| signed out | Redirected/denied by existing authentication |

Also request a protected Lead Control asset while unauthorized.

Expected: the asset is denied; there is no separate login, app, command, or browser workflow.

### LC-05: Read-only mutation gate

While `LEAD_CONTROL_WRITES_ENABLED=false`:

1. Confirm campaign setup, activation, spend, archive, delete, and manual-attribution controls are hidden or disabled.
2. Confirm campaign/summary/revision/spend/sync-health/reconciliation `GET` requests remain available.
3. Call both calculator `POST` routes and confirm they remain available.
4. Attempt at least one request from every persistence family: campaign create/update/archive/delete, forecast create/update/approve/revise/delete, spend create/update/mode-switch/delete, and manual attribution.

5. Submit a normal raw Audit Sales bulk confirmation containing normalized metrics.

Expected: every Lead Control persistence request returns the stable `403` read-only response before any database mutation. Calculators and reads still work. Raw bulk events/summaries still save, but campaign resolution is not called and no Lead Control normalized metrics, normalized phone, campaign ID, or attribution fields are created.

### LC-06: Forward and reverse calculator controls

Enter the fixed fixture without saving it.

Expected:

- `$100 ÷ $1.50` displays `66.7` messages.
- The full funnel matches the fixed expected table.
- Target `10` net bookings returns `$555.56`.
- Rates below `0%` or above `100%`, negative budget, zero cost/message, invalid month, and an impossible positive target with zero conversion are rejected.
- Zero target net bookings returns `$0.00`.

### LC-07: Historical Excel comparison

Select at least three campaigns: one good-performing month, one poor-performing month, and one with cancellations in a later month.

For each campaign, compare:

- budget and cost/message;
- messages, phones, visits, gross bookings, cancellations, net bookings;
- actual spend and planned spend-to-date;
- cost per result and each independent `Good`, `Bad`, or `Pending` status;
- booking-cohort and cancellation-event-month totals.

Expected: unexplained variance is zero after applying the same rates, Cambodia dates, and one-decimal display rule. Record spreadsheet version, source cells, dashboard values, variance, explanation, reviewer, and boss decision.

Gate: obtain written boss approval before enabling writes.

## Phase 2 — campaign and forecast workflow

Enable only:

```text
LEAD_CONTROL_WRITES_ENABLED=true
LEAD_CONTROL_SYNC_ENABLED=false
```

### LC-08: Guided campaign creation

1. Open **Set up campaign**.
2. Complete the four steps in order: Campaign, Budget, Expectations, Review.
3. Enter the fixed fixture.
4. Verify the live preview before approval.
5. Save and approve.

Expected: the browser sends one `POST /lead-control/workflows/campaign-forecast`; the campaign becomes active, the baseline is revision `1`, the funnel matches LC-06, and campaign/forecast approval audit events contain the authenticated actor and time. Injected failure at campaign, forecast, approval, audit, or activation leaves no partial state.

### LC-09: Validation and overlapping ranges

1. Try missing required campaign fields.
2. Try invalid dates and out-of-range conversion rates.
3. Try to activate another campaign on `LC E2E Page` whose dates overlap September.
4. Create a non-overlapping October campaign on the same page.

Expected: validation failures do not persist partial records; the overlap returns `409`; the October campaign is allowed.

### LC-10: Immutable baseline and revisions

1. Reopen the September campaign.
2. Change budget to `$120.00` and approve.
3. Inspect forecast history.
4. Attempt to overwrite or delete the original approved baseline through the API.

Expected: revision `2` is created; revision `1` remains unchanged and readable; overwrite/delete is rejected; revision approval is audit logged.

### LC-11: Archive and delete rules

1. Create an empty draft campaign and delete it.
2. Try to delete the approved September campaign.
3. Archive the September campaign.

Expected: an empty draft with zero revisions can be hard-deleted. A draft with a forecast revision must first delete the eligible draft through `DELETE /lead-control/forecasts/:id`. Protected campaigns cannot be hard-deleted; archive succeeds and preserves forecast/audit history. Archived campaigns show no mutation controls and reject every forecast/spend mutation, including archived-spend updates.

## Phase 3 — spend, pacing, and actual funnel data

### LC-12: Daily spend and pacing

Use a fresh active campaign or unarchive only through an approved operational process.

1. Select daily spend mode.
2. Enter daily records totaling `$45.00` through `2026-09-15`.
3. Open the September summary with `asOf=2026-09-15`.

Expected: planned spend is `$50.00`; actual is `$45.00`; remaining full-month budget is `$55.00`; pacing variance is `-$5.00`/Behind; spend-adjusted funnel expectations match the mid-month fixture.

### LC-13: Spend-mode exclusivity

1. With active daily records, try to add a monthly total without confirmation.
2. Confirm the switch and enter monthly spend.
3. Switch back to daily with confirmation.

Expected: unconfirmed switch is rejected; confirmed switch archives the previous mode's records and keeps audit history; daily and monthly records are never simultaneously active for one campaign-month.

### LC-14: Bulk-entry normalization and raw preservation

Submit a daily Audit Sales report for `LC E2E Page` and a September business date. Keep its original report text/counters, then review normalized fields as:

```text
Messages = 32
Valid phone leads = 10
Completed property visits = 5
```

Expected:

- `daily_summaries.normalized_metrics` stores the three reviewed integers.
- `campaign_id` resolves automatically from page plus inclusive active date.
- Original `raw_text` and raw `counters` are unchanged.
- The corresponding lead events retain the resolved campaign ID for later attribution.
- Negative or fractional normalized counters are rejected.
- No campaign match stores normalized data with `campaign_id: null`; multiple matches fail rather than guessing.

### LC-15: Independent statuses and zero denominators

With `$45.00` actual spend and the LC-14 actuals:

1. Inspect Messages, Phones, and Visits rows.
2. Temporarily validate a low-result fixture such as `20` messages, `4` phones, `1` visit.
3. Validate a zero-result fixture.

Expected:

- Each outcome and each cost/result has its own separately labelled status; there is no overall score.
- Actual at/above expected is `Good`; below is `Bad`.
- Cost at/below forecast is `Good`; above is `Bad`.
- A known zero actual against a positive expectation is a `Bad` outcome while its zero-denominator cost remains `Pending`.
- No completed sync produces `Pending` booking actuals; a completed sync with zero bookings produces known zero booking actuals.

## Phase 4 — Payment Tracker synchronization and attribution

Provision a staging source credential with exactly `find` and `listIndexes` on `ar_tracker.sales`. Never use the Payment Tracker application's broad credential.

Enable:

```text
LEAD_CONTROL_SYNC_ENABLED=true
LEAD_CONTROL_SYNC_INTERVAL_MINUTES=15
```

### LC-16: Credential boundary

Test these credentials separately:

1. exact collection-scoped `find` + `listIndexes`;
2. missing `listIndexes`;
3. database-wide `read`;
4. any write/admin permission;
5. another collection/namespace.

Expected: only case 1 connects. All others fail closed before sync. No source row, phone, URI, or credential is logged.

### LC-17: Scheduler lifecycle and health

1. Restart with sync enabled.
2. Observe the count-only completion log.
3. Confirm the next tick follows the configured Cambodia-time interval.
4. Simulate a slow run across the next tick.
5. Simulate a source error, then restore the source.
6. Shut down during/after a run.

Expected: one run at a time; no duplicate overlapping import; source reads are bounded to 500 rows with a 30-second query timeout and cursor checkpoint after each page; errors are logged and later ticks recover; shutdown waits safely, stops cron, and disconnects; health moves from `Pending` to `Healthy`, and becomes `Stale` when the cursor exceeds 24 hours from the current server instant (not summary `asOf`).

### LC-18: Automatic attribution and frozen history

Use sanitized phones and dates:

1. Create two qualifying Audit Sales leads with the same normalized phone before a booking; the second is more recent.
2. Insert/update a staging sale with that phone and a later booking date.
3. Run/wait for sync.
4. Edit the old lead or create a newer lead after the booking; sync the same sale again.

Expected: the sale is attributed to the most recent qualifying lead created before the booking instant, including an earlier lead on the same Phnom Penh date. Test `16:59:59Z` and `17:00:00Z`. The selected campaign/lead attribution is frozen and does not change on later syncs, lead edits, or a deterministic concurrent manual-attribution interleaving.

### LC-19: Idempotency, updates, and delayed cancellation

1. Sync one sale twice without changing it.
2. Update its allowed source facts/status and sync again.
3. Add a cancellation date in a later month and sync again.

Expected: no duplicate projection; source facts update; frozen attribution remains; delayed cancellation appears in reporting; cursor advances deterministically by `updated_at` then `sale_id`.

### LC-20: Unmatched reconciliation

1. Sync a sale with no qualifying normalized phone lead.
2. Confirm it appears in the unmatched queue.
3. Review the sale in Payment Tracker.
4. Manually attribute it to the test campaign.
5. Try to attribute it again.

Expected: a missing campaign or campaign whose active dates do not cover the Phnom Penh booking date is rejected inside the same transaction. The first valid attribution writes only to Lead Control, records `sale.manually_attributed`, freezes the campaign, and removes the sale from unmatched. The second attempt is rejected. Payment Tracker remains unchanged.

### LC-21: Malformed source rows

Test a row with missing/invalid sale ID, status, phone, booking date, updated date, completion date, or cancellation date.

Expected: it does not enter the sales projection; a local reason is recorded; malformed count increases; valid rows in the same sync still process.

## Phase 5 — bookings, cancellations, summary, and audit

### LC-22: Booking and cancellation views

Use one September booking cancelled in October and one September booking not cancelled.

Expected:

- September booking-cohort view shows both gross bookings.
- September cohort net becomes provisional/reduced only on or after the relevant Cambodia cancellation date.
- October cancellation-event view shows the October cancellation.
- A cancellation is `Good` at/below the forecast rate and `Bad` above it.
- Switching views does not rewrite frozen attribution.

### LC-23: Monthly boundary and active-day prorating

Test records around `17:00:00Z`, which is midnight the next day in Phnom Penh, plus a campaign active for only part of a month.

Expected: booking/cancellation months use the Phnom Penh calendar date; planned spend prorates only active campaign days; impossible dates are rejected rather than rolled into another month.

### LC-24: Audit completeness

Perform one of each permitted mutation: campaign create/update/activate/archive/delete-draft, forecast draft/update/approve/revise/delete-draft, spend create/update/mode-switch/delete, and manual attribution.

Expected: each action has the authenticated actor, timestamp, entity, and action. No approved baseline, archived spend history, or attribution history is missing.

## Phase 6 — usability and resilience

### LC-25: Desktop, narrow screen, keyboard, and Khmer

Test at desktop and approximately `390 × 844`.

Expected: no page-level horizontal overflow; wide ledgers scroll locally; four-step setup remains usable; focus is visible; all controls work by keyboard; reduced-motion preference is respected; Khmer labels render without missing glyphs.

### LC-26: Failure recovery

Test source outage, Audit Sales database outage, invalid JSON, malformed query dates/months, stale sync, and application restart.

Expected: stable `400`/`403`/`404`/`409` responses where applicable; no partial mutation; no source write; audit/history remains intact; health clearly shows `Pending` or `Stale`; restart resumes from the saved cursor.

### LC-27: Disable and rollback drill

1. Set `LEAD_CONTROL_WRITES_ENABLED=false` and restart.
2. Set `LEAD_CONTROL_SYNC_ENABLED=false` and restart.
3. Revoke source network access/credential.
4. Confirm reads/history remain available.
5. Practice application rollback and database restore using the recorded staging snapshot.

Expected: new mutations and source reads stop; existing campaigns, approved baselines, spend, projections, unmatched/malformed records, and audit history remain; Payment Tracker is never restored or overwritten from Audit Sales.

## Boss acceptance walkthrough

Present these screens in this order:

1. Audit Sales navigation and role access.
2. Read-only comparison banner.
3. `$100 / $1.50 = 66.7 messages` and `$555.56` reverse calculation.
4. Historical Excel comparison evidence.
5. Campaign → Budget → Expectations → Review setup.
6. Monthly budget pacing and independent funnel statuses.
7. Baseline plus revision history.
8. Normalized actual messages/phones/visits with raw source preserved.
9. Booking-cohort versus cancellation-event views.
10. Sync health, frozen attribution, and unmatched reconciliation.
11. Audit history and archive-only protected campaign.
12. Narrow/mobile and Khmer rendering.

## Release sign-off

All boxes are required before operational rollout:

- [ ] Automated suite, typechecks, build, diff check, and 20-index audit pass.
- [ ] Developer/manager allowed; agent and signed-out users denied.
- [ ] Read-only gate blocks every mutation while calculators and reads work.
- [ ] Boss signs the historical Excel comparison.
- [ ] Forward/reverse forecast controls match the fixed fixture.
- [ ] Baseline immutability and revision history pass.
- [ ] Daily/monthly spend exclusivity and pacing pass.
- [ ] Raw daily source data remains unchanged beside normalized metrics.
- [ ] Exact source privilege test passes; broader credentials fail closed.
- [ ] Scheduler lifecycle, idempotency, delayed cancellation, and recovery pass.
- [ ] Automatic/manual attribution is frozen and Payment Tracker is unchanged.
- [ ] Cohort/event cancellation reporting and Phnom Penh boundaries pass.
- [ ] Audit/archive/delete rules pass.
- [ ] Desktop, narrow, keyboard, focus, reduced-motion, and Khmer checks pass.
- [ ] Disable/rollback drill passes.
- [ ] No unresolved Critical or Important defects remain.

After sign-off, enable campaign/forecast writes for named operators first, then spend editing for one pilot campaign. Keep sync and write controls independently reversible.
