# Lead Control operational rollout

## Scope and safety boundary

Lead Control is an Audit Sales dashboard at `/lead-control`, not a separate app or browser workflow. It uses existing Audit Sales sessions: only `developer` and `manager` are allowed; `agent` receives `403`.

Payment Tracker remains authoritative for booking, completion, cancellation, and source history. Lead Control reads only fixed `ar_tracker.sales`, then stores its local projection and frozen attribution. It never updates Payment Tracker. Manual attribution changes only the local projection and records `sale.manually_attributed`.

All persisted money is integer USD cents; rates are decimals from 0 through 1. Business reporting dates, pacing, booking cohorts, and cancellation-event months use `Asia/Phnom_Penh`. For example, `$100` is `10000` cents and `$1.50` is `150` cents: `10000 / 150 = 66.7` messages (one decimal display).

## Access and credentials

The Audit Sales database (`DATABASE_URL`) owns the Lead Control collections and may write them. `LEAD_CONTROL_SALES_DATABASE_URL` is a separate Payment Tracker source credential. Provision a distinct MongoDB custom role with exactly this privilege:

| Resource | Allowed actions |
| --- | --- |
| `ar_tracker.sales` | `find`, `listIndexes` |

Never grant built-in database-wide `read`, wildcard access, `insert`, `update`, `remove`, `createIndex`, `dbAdmin`, or `atlasAdmin`. The source target is fixed in code; the URI supplies credentials only. `PaymentSalesSourceConnection.connect()` calls `connectionStatus` with `showPrivileges: true` and `validateSalesSourcePrivileges` rejects missing actions, another namespace, database-wide access, or any extra write/admin action. Never record URIs or tokens in docs, tickets, recordings, screenshots, logs, or commits.

Use only a secret-store value such as:

    LEAD_CONTROL_SALES_DATABASE_URL=<collection-scoped-read-only-secret>

The connection is fail-closed with 10-second server-selection and connect timeouts. Successful `connect()` is the credential-validation gate for a controlled source runner.

## Local collections and indexes

`MongoLeadControlRepository` creates local indexes lazily when a non-session repository is first constructed. No manual index script is necessary. Confirm the local Audit Sales database user can create these indexes; an error is logged as `Lead Control index creation failed`.

| Collection | Purpose | Indexes |
| --- | --- | --- |
| `lead_control_campaigns` | Campaign definition/archive state | `active_page_date_lookup`, unique `same_page_range_guard` |
| `lead_control_forecast_revisions` | Baselines and revisions | unique `campaign_month_revision`, `campaign_month_status` |
| `lead_control_spend_records` | Daily/monthly USD-cent spend | unique partial `active_spend_record_guard`, `campaign_month_spend_lookup` |
| `lead_control_audit_events` | Campaign/forecast/spend audit | `entity_audit_history`, `actor_audit_history` |
| `lead_control_mutation_guards` | Local serialization guard | `mutation_guard_version` |
| `lead_control_sales_projections` | Local normalized sale projection | unique `sale_id_unique`, `phone_booking_lookup`, `campaign_booking_lookup`, `unmatched_reconciliation_lookup`, `status_booking_lookup`, `status_cancellation_event_lookup`, `source_updated_cursor_lookup` |
| `lead_control_sales_sync_cursor` | `_id: "sales"` source cursor | none |
| `lead_control_malformed_sales` | Rejected source-row reasons | `malformed_sales_recorded_at` |
| `lead_control_sales_audit_events` | Manual-attribution audit | `sale_audit_history` |
| existing `leads_events` | Local lead attribution lookup | `sale_attribution_normalized_phone_date` |
| existing `daily_summaries` | Local normalized actual funnel | `campaign_month_summary_lookup` |

Raw data remains intact. Lead Control reads `daily_summaries.normalized_metrics` without replacing raw report fields. Its source projection requests only `sale_id`, `status`, `phone`, dates, and `updated_at` (`_id: 0`).

## Sync, health, and reconciliation

Audit Sales now owns a dedicated Lead Control scheduler. It remains disabled unless `LEAD_CONTROL_SYNC_ENABLED` is exactly `true`; while disabled it registers no cron and opens no Payment Tracker source connection. When enabled, it runs at `LEAD_CONTROL_SYNC_INTERVAL_MINUTES` (default 15, valid integer range 5–60) in `Asia/Phnom_Penh`, permits only one in-flight run, validates the source credential through `PaymentSalesSourceConnection`, and composes `PaymentSalesSourceRepository`, `SyncSalesService`, and `MongoLeadControlRepository`. A tick failure is contained and logged; successful logs contain only `read`, `saved`, and `malformed` counts. Shutdown stops cron, waits for an in-flight run, and disconnects the source.

Synchronization orders by `{ updated_at: 1, sale_id: 1 }`, reads bounded pages of at most `500` rows with a `30` second source-query timeout, and checkpoints the local `{ updated_at, sale_id }` cursor after every completed page. Malformed rows retain a local reason but do not enter the projection. Each valid sale reread, attribution decision, and projection upsert runs in one local transaction locked by sale ID, so a concurrent manual attribution cannot be overwritten. A valid projection preserves the first non-null campaign attribution across later source updates. Automatic attribution uses the most recent qualifying local lead created before the booking instant, including an earlier lead on the same Phnom Penh business date. Unmatched sales remain queryable; automatic or manual attribution is frozen.

| Endpoint | Operational use |
| --- | --- |
| `GET /lead-control/sync/health` | `Pending`/`Healthy`/`Stale`, real-time cursor age, unmatched and malformed count |
| `GET /lead-control/reconciliation/unmatched` | Reconciliation queue |
| `GET /lead-control/campaigns/:id/summary?month=YYYY-MM&asOf=YYYY-MM-DD` | Forecast/actual ledger and health |
| `GET /lead-control/campaigns/:id/cancellations?month=YYYY-MM&view=cohort` | Booking-cohort cancellations |
| `GET /lead-control/campaigns/:id/cancellations?month=YYYY-MM&view=event` | Cancellation-event-month view |

`Pending` means no completed sync cursor. A completed sync with zero bookings reports known zero actuals rather than `Pending`. `Stale` means the cursor is older than 24 hours at the server's current injected instant; historical summary `asOf` remains separate. Reconcile source facts in Payment Tracker by sale ID; never alter a source record from Lead Control. `POST /lead-control/sales/:saleId/attribution` is the only local resolution and must follow source review. In the same transaction it verifies the campaign exists and its Phnom Penh active-date range covers the sale booking date; no correction endpoint is exposed after attribution freezes.

Synchronization remains off by default. Enable it only after the narrow source credential is provisioned and checked; do not call the source with an ad-hoc shell command. With sync disabled, health remains `Pending` until an approved enabled deployment completes its first successful tick.

## Audit, immutability, and archive rules

Campaign/forecast/spend mutations record actor, time, entity, and details in `lead_control_audit_events`: `campaign.created`, `campaign.updated`, `campaign.activated`, `campaign.deleted`, `campaign.archived`, `forecast.draft_created`, `forecast.draft_updated`, `forecast.draft_deleted`, `forecast.approved`, `forecast.revision_created`, `spend.recorded`, `spend.updated`, `spend.deleted`, and `spend.mode_switched`. Sales manual attribution is separately audited as `sale.manually_attributed`.

An approved forecast cannot be changed or deleted. Later work creates a new draft revision for the same month; the approved baseline remains. `DELETE /lead-control/forecasts/:id` removes only an eligible draft. A campaign cannot be hard-deleted while any forecast revision exists; delete eligible forecast drafts first. Daily and monthly spend are mutually exclusive per campaign-month. A confirmed mode switch archives prior entries. Archived campaigns reject all forecast and spend mutations, and archived spend records cannot be updated or deleted. A campaign with an approved forecast or any spend has protected history and must be archived through `POST /lead-control/campaigns/:id/archive`; it cannot be hard-deleted. Active and archived campaigns cannot be deleted either.

The guided setup UI submits one authenticated `POST /lead-control/workflows/campaign-forecast` command. Campaign create/edit, forecast draft/revision save, optional approval, activation, and audit events commit in one Audit Sales transaction and the response returns the final campaign plus forecast. Granular campaign and forecast APIs remain available for operational compatibility.

## Staged deployment, enablement, and rollback

### Phase 0 — prepare

1. Take a tested, restorable Audit Sales database backup/snapshot. Record backup ID, deployment time, and application revision in the change ticket.
2. Deploy normally; check `/health` and `/reports/health`, sign in as a manager, and confirm **Lead Control** is in the existing Audit Sales navigation at `/lead-control`. Confirm `agent` is rejected.
3. Set `LEAD_CONTROL_WRITES_ENABLED=false` and `LEAD_CONTROL_SYNC_ENABLED=false`. Keep the source URI only in the secret store.
4. Configure the Phase 1 gateway allowlist before production users enter.
5. Run `npm run verify:lead-control-indexes` with the local Audit Sales `DATABASE_URL` and attach the successful count to the change ticket. This reads MongoDB `listIndexes` and verifies every name, full ordered key, `unique`, `sparse`, and `partialFilterExpression` contract. A same-named but structurally weaker index fails the audit.

### Phase 1 — required read-only comparison

Keep `LEAD_CONTROL_WRITES_ENABLED=false`. The application returns `403` with `Lead Control is in read-only comparison mode` for every Lead Control persistence `POST`, `PUT`, `PATCH`, and `DELETE`; only `GET`/`HEAD`, assets, and the two non-persisting calculator calls remain available. Existing `POST /data-entry/api/bulk/confirm` remains available for raw Audit Sales entry, but it skips campaign resolution and writes no `normalized_metrics`, normalized phone, campaign ID, or lead-event attribution fields. A gateway allowlist using the same policy is recommended defense in depth.

The page clearly labels this phase **Read-only comparison mode**, hides campaign setup/edit/activation, spend recording, approval, and manual-attribution controls, and keeps the comparison calculator and read views available.

For every boss-selected historical campaign, compare approved Excel inputs and formula results with the calculator and any existing local summary: budget, cost/message, messages, phones, visits, gross bookings, cancellations, net bookings, actual spend, and pacing. Apply identical Cambodia month/date boundaries. Retain a signed comparison row with reviewer, source spreadsheet version, results, variance explanation, and the `$100 / $1.50 = 66.7 messages` control. Stop at Phase 1 if a material difference is unexplained.

### Phase 2 — operational writes after boss confirmation

Only after written boss confirmation of the historical comparisons, credential review, backup, named manager/developer operators, and a successful full index-structure audit may the deployment owner set `LEAD_CONTROL_WRITES_ENABLED=true` and restart Audit Sales. If the index command exits nonzero, writes must remain disabled; repair the reported index definition and rerun the audit. Keep use limited to existing developer/manager accounts. Enable campaign/forecast approval first and verify its audit event and immutable baseline. Then allow a small named campaign's spend recording and verify cents, selected daily/monthly mode, pacing, and audit event.

Source sync is a separate decision. After verifying the collection-scoped `ar_tracker.sales` credential, set `LEAD_CONTROL_SYNC_ENABLED=true`, optionally set the validated interval, restart Audit Sales, and confirm the first count-only completion log plus `GET /lead-control/sync/health`. Writes may remain disabled while sync runs.

### Disable and rollback

Immediately set `LEAD_CONTROL_WRITES_ENABLED=false` and `LEAD_CONTROL_SYNC_ENABLED=false`, restart Audit Sales, restore the Phase 1 gateway deny rules, and revoke the source credential or its network access if source access must be terminated independently. This stops new Lead Control writes and source reads without modifying Payment Tracker. Roll back the Audit Sales application to the recorded revision if needed. Never delete Lead Control collections as rollback: retain audit, projections, malformed rows, spend history, and baselines. Restore local collections only from the verified pre-change backup after an incident decision; never overwrite Payment Tracker from this system.

## Verification

Run before deployment and attach results to the internal change record:

    npm test
    npm run typecheck:test
    npm run typecheck
    npm run build
    git diff --check
    npm run verify:lead-control-indexes

The database-backed index command is mandatory in the target pre-release environment; its success confirms all 20 index names, ordered keys, and safety options from the local collections table, including the two existing-collection lookup indexes. A failure is a write-enablement stop condition. Also verify role enforcement, embedded navigation, responsive UI, calculator control, approved-baseline immutability, archive-only protected campaigns, spend-mode exclusivity, preservation of raw source data, application-level Phase 1 denial of every mutation route, and optional matching gateway denial. Test backup restoration outside production before it is ever needed.
