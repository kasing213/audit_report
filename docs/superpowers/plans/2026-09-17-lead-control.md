# Lead Control Inside Audit Sales — Implementation Plan

> Execute this plan in the `feature/lead-control` worktree. Use test-driven development for every behavior change. Each task must finish with a focused commit and a short report under `.superpowers/sdd/2026-09-17-lead-control/reports/`.

## Product boundary

Lead Control is a boss/admin feature inside Audit Sales. Audit Sales owns campaign setup, forecasts, spend, daily normalized funnel metrics, frozen attribution, synchronization state, and reconciliation. Payment Tracker remains the only authority for sale creation, completion, and cancellation. All money is stored as integer USD cents; rates are decimal values from 0 to 1; business dates use `Asia/Phnom_Penh`.

## UI design direction

- Keep Audit Sales' dark charcoal surfaces, teal accent, and current typography so the feature feels native.
- Make the memorable element a horizontal campaign funnel rail (budget → messages → phones → visits → bookings → net), not a generic grid of dashboard cards.
- Use a real four-step guided sequence for campaign setup, with one decision group per screen and an always-visible forecast preview.
- Present dense operational data as quiet ledger rows with aligned numerals; reserve color for `Good`, `Bad`, and `Pending` states.
- Keep radii restrained, avoid decorative gradients, support Khmer/English labels, keyboard focus, reduced motion, and responsive stacking.

## Data model target

Create Lead Control collections for campaigns, monthly forecast periods, immutable forecast revisions, actual spend records, daily normalized metrics, synchronized sale projections, frozen sale attribution, sync state, unmatched sales, and audit events. Approved baseline revisions are immutable. Campaigns with approved forecasts or actual records can only be archived. Daily and monthly spend modes are mutually exclusive for a campaign-month.

## Task 1 — Forecast and classification domain

**Own:** `src/lead-control/types.ts`, `src/lead-control/forecast.ts`, `tests/lead-control/forecast.test.ts`, `tests/all.test.ts`.

1. Add failing tests for forward forecast, `$100 / $1.50 = 66.7` messages, reverse net-booking budget, input validation, one-decimal display helpers, active-day monthly proration, zero-denominator behavior, and direct `Good`/`Bad`/`Pending` classification for outcomes, cost per result, and cancellation rate.
2. Run the focused tests and record the expected failure.
3. Implement pure, deterministic forecast and status functions without database or HTTP dependencies.
4. Run focused tests, typecheck, and commit.

## Task 2 — Campaign, revisions, spend, and audit persistence

**Own:** `src/lead-control/models.ts`, `src/lead-control/repository.ts`, `src/lead-control/service.ts`, `tests/lead-control/campaign-service.test.ts`.

1. Add tests around campaign validation, same-page date overlap rejection, draft deletion, archive-only protected campaigns, immutable baseline approval, revision creation, daily/monthly spend exclusivity, confirmed mode switching, and audit events.
2. Add typed Mongo documents and repository interfaces plus a service that enforces the invariants independent of Mongo.
3. Add Mongo-backed repository methods and collection indexes, including a defensive unique/lookup strategy where Mongo can enforce it and service-level overlap checks where it cannot.
4. Verify focused tests and typecheck, then commit.

## Task 3 — Lead Control HTTP routes and permissions

**Own:** `src/api/lead-control-routes.ts`, `src/api/server.ts`, `tests/lead-control/routes.test.ts`.

1. Add route tests for campaign list/create/edit/detail/archive/delete, draft/approve/revise forecasts, spend CRUD/mode switch, calculator modes, and forbidden agent access.
2. Mount `/lead-control` behind existing authentication. Allow `developer` and `manager`; reject other roles for protected UI/API operations.
3. Return validation and conflict errors with stable status codes and messages. Ensure actor metadata reaches every audited mutation.
4. Verify focused route tests and typecheck, then commit.

## Task 4 — Bulk-entry normalization and automatic campaign resolution

**Own:** `src/database/models.ts`, `src/database/repository.ts`, `src/api/data-entry-routes.ts`, `src/reports/templates/bulk-data-entry.hbs`, relevant parser helpers, `tests/lead-control/bulk-normalization.test.ts`.

1. Add failing tests proving editable normalized messages, valid phone leads, and completed visits are saved while existing raw report text and raw counters remain unchanged.
2. Resolve campaign by page plus business date and persist the resolved campaign ID with normalized metrics.
3. Reject ambiguous/overlapping resolution defensively and retain compatibility for entries without a matching campaign.
4. Verify focused tests, typecheck, and existing bulk-entry tests, then commit.

## Task 5 — Read-only Payment Tracker sales synchronization and frozen attribution

**Own:** `src/lead-control/payment-sales-source.ts`, `src/lead-control/sync-service.ts`, `tests/lead-control/sync-service.test.ts`, `.env.example` additions specific to the connector.

1. Add tests for incremental synchronization by `sale_id`/`updated_at`, repeated and updated sales, delayed cancellations, field normalization, and source credential privilege checks.
2. Match each sale to the most recent qualifying normalized lead with the same normalized phone before its booking date. Freeze the first accepted campaign attribution so later lead edits cannot rewrite history.
3. Keep unmatched records queryable for reconciliation. Implement manual attribution as an audited Lead Control write only; never write to Payment Tracker.
4. Use a dedicated collection-scoped read-only connection setting for the `sales` collection and fail closed if the effective privileges exceed the documented scope.
5. Verify focused tests and typecheck, then commit.

## Task 6 — Monthly summary, cancellation views, and reconciliation

**Own:** `src/lead-control/summary-service.ts`, summary/sync query portions of `src/api/lead-control-routes.ts`, `tests/lead-control/summary-service.test.ts`.

1. Add tests for planned spend-to-date over active days, actual spend, remaining budget, pacing variance, full-month forecast, spend-adjusted forecast, actual funnel counts, per-stage variance/cost/status, and provisional open-month net bookings.
2. Add cohort-month and cancellation-event-month cancellation views.
3. Add baseline/latest/revision history, unmatched-sale reconciliation, and sync-health query results.
4. Verify focused tests and typecheck, then commit.

## Task 7 — Guided setup and campaign summary UI

**Own:** new templates/assets under `src/reports/templates/lead-control*` and `src/reports/public/lead-control*`, `src/reports/templates/partials/nav.hbs`, HTML handlers in `src/api/lead-control-routes.ts`, UI-oriented tests.

1. Add `Lead Control` to the existing dashboard navigation for authorized users.
2. Build the four-step create/edit flow with prefilled edits, live budget-to-results and target-to-budget preview, validation, review, approval, and revision messaging.
3. Build a one-month summary using the funnel rail and ledger rows. Include pacing, actuals, independent statuses, cancellation view toggle, revision history, reconciliation, and sync health.
4. Confirm responsive behavior, keyboard operation, visible focus, Khmer-capable text rendering, and reduced motion. Capture and inspect at least desktop and narrow screenshots.
5. Run UI tests, full tests, typecheck, and build, then commit.

## Task 8 — Operational rollout and training handoff

**Own:** `docs/lead-control/`, remaining `.env.example` documentation, index/setup scripts if needed.

1. Document collection/index setup, read-only Payment Tracker credential requirements, synchronization operations, audit trail, archival rules, and rollback/disable procedure.
2. Document read-only comparison rollout first, historical campaign validation against the Excel calculations, then controlled enablement of campaign creation and spend editing.
3. Provide a Khmer walkthrough outline, exact screen order, narration points, and a recording checklist for Claude Design. Do not build or embed a video.
4. Run the complete test suite, test typecheck, production typecheck/build, inspect git diff/status, and commit.

## Completion gate

- All new and existing tests pass.
- `npm run typecheck:test`, `npm run typecheck`, and `npm run build` pass.
- The `$100` at `$1.50/message` example reports approximately `66.7` messages.
- The UI is visibly integrated into Audit Sales and does not open a separate app or browser workflow.
- Approved baseline forecasts cannot be overwritten, source raw data remains preserved, and Payment Tracker remains read-only.
- A final whole-branch review reports no unresolved critical or important findings.
