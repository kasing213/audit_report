# Task 10 — Final release-review fix report

Date: 2026-09-18
Starting revision: `7b3e1f4`
Scope: one coherent final-review fix wave for the Lead Control branch

## Outcome

All Critical, Important, and release-hardening findings in the binding fix brief are addressed. The implementation keeps Payment Tracker read-only, preserves raw Audit Sales history, preserves approved baselines and frozen sale attribution, defaults Lead Control writes to disabled, and does not add sensitive source data to logs. Existing granular operational APIs remain available; the guided browser workflow now uses one authenticated atomic backend command.

## TDD evidence

Each behavior change started with focused regression coverage. The initial RED failures were correct for the following reasons:

1. **Default read-only bulk gate**
   - RED: the production-mounted bulk confirmation had no Lead Control write-state dependency, called campaign resolution, and emitted Lead Control normalized/attribution fields even when writes defaulted off.
   - GREEN: `ApiServer` passes the same explicit write flag into a router factory. Disabled mode still stores raw Audit Sales events and summaries but does not resolve campaigns or write `normalized_metrics`, normalized phone, campaign IDs, or lead attribution fields.

2. **Concurrent sync versus manual attribution**
   - RED: sync read the prior projection before entering a transaction, allowing an interleaved manual attribution to be overwritten by a stale automatic result.
   - GREEN: every valid sale projection reread, attribution decision, and upsert runs inside `runSalesAtomic([sale:<id>])`. A deterministic interleaving test proves the manual campaign remains frozen.

3. **Archived campaign immutability**
   - RED: archived campaigns still accepted forecast and spend mutations, archived spend could be updated, and browser controls remained visible.
   - GREEN: every forecast/spend mutation requires a mutable campaign; archived spend update/delete is rejected; archived detail hides edit, spend, activation/setup, and manual-attribution affordances.

4. **Draft deletion and forecast cleanup**
   - RED: draft campaign deletion could orphan draft revisions and `DELETE /lead-control/forecasts/:id` returned 404.
   - GREEN: hard deletion requires zero revisions, the forecast delete route is write-gated and removes only eligible drafts, and approved baselines remain immutable.

5. **Bulk attribution granularity and preflight validation**
   - RED: every lead event inherited one summary-level campaign and an early event could persist before a later ambiguous campaign resolution failed.
   - GREEN: each event resolves with its own effective page/date, the summary resolves separately, and every campaign resolution completes before any repository write.

6. **Phnom Penh booking-date attribution**
   - RED: the persisted query used strict date-before matching and excluded a qualifying same-day lead.
   - GREEN: attribution uses the `Asia/Phnom_Penh` business date and includes same-day leads whose `created_at` is before the booking instant, including the `16:59:59Z`/`17:00:00Z` boundary.

7. **Independent outcome and cost status**
   - RED: the API exposed one combined `status`; a known zero booking result was indistinguishable from missing sync data.
   - GREEN: each stage exposes and renders `outcomeStatus` and `costStatus`. Zero actual against positive expectation is Bad while its undefined cost remains Pending. A completed sync with no campaign bookings yields known zeros; no cursor remains Pending.

8. **Full index safety verification**
   - RED: a same-named index with reversed keys or missing `unique`, `sparse`, or partial-filter safety options passed the name-only verifier.
   - GREEN: all 20 definitions are compared by name, full ordered key, `unique`, `sparse`, and normalized `partialFilterExpression`. Rollout documentation makes any mismatch a hard stop before enabling writes.

9. **Atomic guided campaign/forecast workflow**
   - RED: the guided browser issued multiple mutations; an approval/audit failure could leave the campaign or draft partially saved, and the unified endpoint did not exist.
   - GREEN: `POST /lead-control/workflows/campaign-forecast` creates/edits the campaign, saves a baseline/revision, optionally approves, optionally activates, and appends all audits in one repository transaction. It returns the final campaign and forecast. Failure injection at `forecast.approved` proves full rollback. The UI sends only this mutation command.

10. **Manual attribution validation**
    - RED: manual attribution accepted an arbitrary campaign ID without checking existence or whether its dates covered the booking.
    - GREEN: sale and campaign are locked together; the service verifies the campaign and its Phnom Penh booking-date applicability before saving and auditing. Draft or out-of-range campaigns are rejected. No correction endpoint was added, so frozen attribution remains preserved.

11. **Operational sync health clock**
    - RED: health age was derived from historical summary `asOf` midnight.
    - GREEN: `SummaryService` accepts an injected current clock and `/sync/health` uses the current instant; report/cohort `asOf` semantics remain separate.

12. **Bulk-entry validation**
    - RED: blank, negative, fractional, and otherwise invalid normalized metrics were silently submitted as zero.
    - GREEN: the browser displays a specific validation error and sends no confirmation request.

13. **Bounded source paging**
    - RED: the source interface performed an unbounded `toArray()` and had no page checkpoints or query timeout.
    - GREEN: sync requests deterministic 500-row pages, the Mongo query uses a 30-second timeout, and each advancing page checkpoints `(updated_at, sale_id)`. A short terminal page containing only an uncursorable malformed row is recorded without aborting; a full non-advancing page still fails safely instead of looping.

14. **Khmer and accessibility evidence**
    - RED/evidence gap: acceptance coverage did not explicitly assert the Khmer-capable font fallback, reduced-motion behavior, separate status labels, or archived control state.
    - GREEN: browser tests assert `Noto Sans Khmer`/Khmer fallback, Khmer glyph content, reduced-motion transition removal, narrow-screen behavior, keyboard-scrollable ledgers, and hidden archived mutations. The existing English UI is retained; no locale subsystem was introduced.

## Implementation summary

- Added a shared Phnom Penh business-date helper used by reporting, automatic attribution, and manual attribution validation.
- Added write-state injection to the data-entry router while preserving the raw bulk-entry path.
- Added a server-owned atomic campaign/forecast workflow plus explicit draft forecast deletion.
- Enforced archive and history invariants across campaign, forecast, spend, and UI paths.
- Made sale import bounded, deterministic, transactional per sale, and query-time-limited.
- Split stage outcome/cost status and separated operational health time from historical reporting time.
- Upgraded index verification from name presence to exact safety contracts.
- Updated the operational rollout, end-to-end runbook, and Khmer walkthrough evidence.

## Verification

Final verification from the completed worktree:

- Focused Lead Control suite: 90 passed, 0 failed.
- Focused sync regression suite: 11 passed, 0 failed.
- `npm test`: 144 passed, 0 failed.
- `npm run typecheck:test`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed (Git emitted only expected Windows LF-to-CRLF working-copy notices).

The tests also confirm that scheduler logs remain aggregate counts only and source credentials/records are not logged.

## Residual deployment gates

- `npm run verify:lead-control-indexes` requires the target pre-release MongoDB `DATABASE_URL` and was not run against an external database in this local fix wave. It remains mandatory before write enablement; any name/key/option mismatch must keep writes disabled.
- The narrow Payment Tracker credential privilege check and the manual Khmer visual recording remain staging/operator acceptance steps in the runbooks.
