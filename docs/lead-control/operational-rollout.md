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

The implemented pieces are `PaymentSalesSourceRepository` and `SyncSalesService`. A controlled runner, once separately implemented and reviewed, must: (1) load the secret; (2) call `PaymentSalesSourceConnection.connect()` and stop on a privilege error; (3) build the adapter from `connection.collection()`; (4) call `SyncSalesService.sync()` against `MongoLeadControlRepository`; (5) log only `read`, `saved`, and `malformed` counts; and (6) disconnect in `finally`.

Synchronization orders by `{ updated_at: 1, sale_id: 1 }` and resumes after the local `{ updated_at, sale_id }` cursor. Malformed rows retain a local reason but do not enter the projection. A valid projection preserves the first non-null campaign attribution across later source updates. Automatic attribution uses the most recent qualifying local lead with the same normalized Cambodian phone before booking. Unmatched sales remain queryable; automatic or manual attribution is frozen.

| Endpoint | Operational use |
| --- | --- |
| `GET /lead-control/sync/health?asOf=YYYY-MM-DD` | `Pending`/`Healthy`/`Stale`, cursor age, unmatched and malformed count |
| `GET /lead-control/reconciliation/unmatched` | Reconciliation queue |
| `GET /lead-control/campaigns/:id/summary?month=YYYY-MM&asOf=YYYY-MM-DD` | Forecast/actual ledger and health |
| `GET /lead-control/campaigns/:id/cancellations?month=YYYY-MM&view=cohort` | Booking-cohort cancellations |
| `GET /lead-control/campaigns/:id/cancellations?month=YYYY-MM&view=event` | Cancellation-event-month view |

`Pending` means no cursor. `Stale` means a cursor older than 24 hours as of the requested Cambodia business date. Reconcile source facts in Payment Tracker by sale ID; never alter a source record from Lead Control. `POST /lead-control/sales/:saleId/attribution` is the only local resolution and must follow source review.

### Current release limitation

`src/index.ts` does not construct `PaymentSalesSourceConnection`, `PaymentSalesSourceRepository`, or `SyncSalesService`; it starts no Lead Control source scheduler or CLI. This release therefore must not be described as automatically synchronized. Health remains `Pending` until a separately reviewed runner is implemented and deployed. Do not invent a cron job or call the source with an ad-hoc shell command.

## Audit, immutability, and archive rules

Campaign/forecast/spend mutations record actor, time, entity, and details in `lead_control_audit_events`: `campaign.created`, `campaign.updated`, `campaign.activated`, `campaign.deleted`, `campaign.archived`, `forecast.draft_created`, `forecast.draft_updated`, `forecast.draft_deleted`, `forecast.approved`, `forecast.revision_created`, `spend.recorded`, `spend.updated`, `spend.deleted`, and `spend.mode_switched`. Sales manual attribution is separately audited as `sale.manually_attributed`.

An approved forecast cannot be changed or deleted. Later work creates a new draft revision for the same month; the approved baseline remains. Daily and monthly spend are mutually exclusive per campaign-month. A confirmed mode switch archives prior entries. A campaign with an approved forecast or any spend has protected history and must be archived through `POST /lead-control/campaigns/:id/archive`; it cannot be hard-deleted. Active and archived campaigns cannot be deleted either. Only a draft with no protected history may be deleted.

## Staged deployment, enablement, and rollback

### Phase 0 — prepare

1. Take a tested, restorable Audit Sales database backup/snapshot. Record backup ID, deployment time, and application revision in the change ticket.
2. Deploy normally; check `/health` and `/reports/health`, sign in as a manager, and confirm **Lead Control** is in the existing Audit Sales navigation at `/lead-control`. Confirm `agent` is rejected.
3. Keep the source URI only in the secret store. Do not enable a source runner in this release.
4. Configure the Phase 1 gateway allowlist before production users enter.

### Phase 1 — required read-only comparison

Allow `GET`/`HEAD` under `/lead-control` and its assets. If path-specific POST rules are supported, allow only non-persisting calculator calls: `POST /lead-control/calculator/budget-to-results` and `POST /lead-control/calculator/target-to-budget`. Deny every other `POST`, every `PUT`, and every `DELETE` under `/lead-control` at the proxy/API gateway.

Do not click **Set up campaign**, **Save draft**, **Save and approve**, **Activate campaign**, **Record spend**, or **Assign to this campaign**. The current UI still renders those controls, so the gateway restriction is mandatory: this code has no `LEAD_CONTROL_ENABLED` or mutation feature flag.

For every boss-selected historical campaign, compare approved Excel inputs and formula results with the calculator and any existing local summary: budget, cost/message, messages, phones, visits, gross bookings, cancellations, net bookings, actual spend, and pacing. Apply identical Cambodia month/date boundaries. Retain a signed comparison row with reviewer, source spreadsheet version, results, variance explanation, and the `$100 / $1.50 = 66.7 messages` control. Stop at Phase 1 if a material difference is unexplained.

### Phase 2 — operational writes after boss confirmation

Only after written boss confirmation of the historical comparisons, credential review, backup, and named manager/developer operators may the deployment owner remove the mutation deny rules. Keep use limited to existing developer/manager accounts. Enable campaign/forecast approval first and verify its audit event and immutable baseline. Then allow a small named campaign's spend recording and verify cents, selected daily/monthly mode, pacing, and audit event. Source sync remains disabled until its separate runner is reviewed.

### Disable and rollback

Immediately restore the Phase 1 gateway deny rules and revoke the source credential or its network access. This stops new Lead Control writes and source reads without modifying Payment Tracker. Roll back the Audit Sales application to the recorded revision if needed. Never delete Lead Control collections as rollback: retain audit, projections, malformed rows, spend history, and baselines. Restore local collections only from the verified pre-change backup after an incident decision; never overwrite Payment Tracker from this system.

## Verification

Run before deployment and attach results to the internal change record:

    npm test
    npm run typecheck:test
    npm run typecheck
    npm run build
    git diff --check

Also verify role enforcement, embedded navigation, responsive UI, calculator control, approved-baseline immutability, archive-only protected campaigns, spend-mode exclusivity, preservation of raw source data, and Phase 1 gateway denial of every mutation route. Test backup restoration outside production before it is ever needed.
