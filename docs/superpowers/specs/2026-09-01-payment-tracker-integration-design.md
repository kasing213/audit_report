# Payment Tracker Outreach Integration — Design Spec

Status: approved architecture; implementation blocked on a read-only source credential
Revised: 2026-09-02

## 1. Purpose

Add Payment Tracker as a third outreach workspace that drafts and sends payment
reminders from `ar_tracker.ar_state`. Payment Tracker uses its own MongoDB
credential, proposal rules, template, approval mode, Telegram StringSession,
worker process, and daily cap. Company and Personal retain their existing
scanner, schedules, caps, sessions, and MTProto send/receive behavior.

The integration records a source snapshot in each proposal but never mirrors,
migrates, updates, or indexes `ar_state`.

## 2. Verified source facts and rollout blocker

Read-only inspection on 2026-09-02 established the following:

- Source namespace: `ar_tracker.ar_state`.
- `ar_id` is a string with a unique `{ ar_id: 1 }` index.
- The status field is `current_status`, not `status`.
- `due_date` is a BSON `Date`.
- `amount` is an object with numeric `value` and string `currency` fields.
- Current sampled records have `customer_phone: null` and
  `credit_applied: null`; those records are ineligible by design.
- A candidate query on `current_status`, `due_date`, and phone presence used the
  existing `{ current_status: 1, due_date: 1 }` index. The inspected collection
  was small, so index use—not current execution time—is the meaningful result.
- Phone validity and “first valid normalized entry” selection cannot be fully
  expressed by the source index and must be completed in application code.

The supplied `D:\Payment-Tracker\.env` credential authenticates with
`atlasAdmin`. It must not be copied into audit-sales. Before implementation can
connect to the source, an Atlas user restricted to the `read` role on only the
`ar_tracker` database must be provisioned as `PAYMENT_TRACKER_DATABASE_URL`.
Credential privilege verification is a deployment gate.

## 3. Scope and invariants

### In scope

- Third `payment_tracker` workspace in dashboard navigation.
- Direct, read-only MongoDB access to `ar_state` through a separate client.
- Daily payment scanning and proposal generation.
- Payment-specific proposal fields, template, approval behavior, verification,
  cancellation, deduplication, suppression, and send gating.
- Strict worker organization enforcement for claim, media, mark-sent, and
  mark-failed operations.
- A guarded Payment Tracker login command and separate PM2 configuration.
- Automated safety tests, Company/Personal regressions, operational checks, and
  staged rollout documentation.

### Invariants

- `ar_state` is read only. audit-sales contains no code path that writes to it
  or calls `createIndex`/`createIndexes` on it.
- No Payment Tracker customer or AR record is mirrored into sales lead events.
- Company and Personal are the only workspaces processed by the existing sales
  scanner.
- Only `PENDING` and `OVERDUE` source statuses are eligible. Every other value,
  including an unknown value, fails closed.
- A worker request with a missing or invalid organization header fails. It
  never defaults to Company.
- A payment reminder cannot be returned to a worker before its exact Cambodia
  due date and a successful live verification.
- Payment failures and rejections suppress only the same normalized phone and
  exact local due date.

## 4. Workspace boundaries

`OUTREACH_ORGS` gains `{ id: 'payment_tracker', label: 'Payment Tracker' }` for
navigation and shared per-workspace repositories. A separate constant such as
`SALES_OUTREACH_ORGS = ['company', 'personal']` is the only list used by the
existing sales scanner. Adding Payment Tracker to navigation therefore cannot
make it consume stale sales leads.

Payment Tracker may reuse the shared `outreach_proposals`, settings, media, and
worker-state collections because they are already organization-scoped. Every
ID-based repository method touched by the worker path must be strengthened to
accept an organization and include both `_id` and `org_id` in its Mongo filter.
Legacy Company documents continue to use the existing Company compatibility
match; Payment Tracker always requires the exact `payment_tracker` value.

Browser workspace resolution may continue to use the workspace cookie. Agent
routes use a new strict resolver that accepts only a non-empty, registered
`X-Org-Id` header. Query parameters, request bodies, cookies, invalid values,
and missing values are not fallbacks on agent routes.

## 5. Source connection and query

A dedicated Payment Tracker connection owns a separate `MongoClient` created
only from `PAYMENT_TRACKER_DATABASE_URL`. It explicitly selects database
`ar_tracker` and collection `ar_state`; it does not reuse `DATABASE_URL` or the
main audit-sales connection singleton.

The daily candidate query is:

```javascript
{
  current_status: { $in: ['PENDING', 'OVERDUE'] },
  due_date: { $lte: endOfTomorrowInCambodia },
  'customer_phone.0': { $exists: true }
}
```

The query uses a strict projection containing only:

```text
ar_id, home_id, customer_name, customer_phone, current_status,
amount, credit_applied, due_date
```

`endOfTomorrowInCambodia` is the instant immediately before the second local
midnight after the scan date. The scanner derives an exact `YYYY-MM-DD` local
date from each BSON `due_date`; it never derives eligibility from UTC calendar
components.

The scanner runs daily at `PAYMENT_TRACKER_SCAN_TIME` (default `10:00`) with
the cron timezone fixed to `Asia/Phnom_Penh`. It is gated by
`PAYMENT_TRACKER_SCAN_ENABLED`, which defaults to `false`.

Mongo connection, query, BSON-type, or record-shape failures fail the scan
closed. A failed scan creates, approves, cancels, or sends nothing. Source
errors are recorded for UI/operations without leaking credentials or customer
data into logs.

## 6. Source normalization and eligibility

Each source document is independently validated:

1. `ar_id` must be a non-empty string.
2. `current_status` must be exactly `PENDING` or `OVERDUE`.
3. `due_date` must be a valid BSON `Date` no later than Cambodia end-of-tomorrow.
4. `customer_phone` must be an array. Entries are considered in source order;
   the first entry that the existing phone normalizer converts to a valid
   normalized phone is the primary contact. Later entries are ignored.
5. `amount.value` and `credit_applied.value` must be finite, non-negative
   numbers. Both currency fields must be non-empty strings and match exactly
   after uppercase normalization.
6. `amount_due` is `max(0, amount.value - credit_applied.value)`. It must be
   positive.

Missing credit is not treated as zero. Missing, null, malformed, negative, or
currency-mismatched monetary data makes the AR ineligible. No values are
estimated or repaired.

`billing_month` is the first seven characters of the derived Cambodia local
due date and exists only for reporting. It does not participate in selection,
deduplication, or suppression.

## 7. Grouping, deduplication, and fingerprinting

Eligible ARs are grouped by:

```text
(payment_tracker, normalized_primary_phone, exact_local_due_date)
```

One proposal represents one group. All ARs in a group must have the same
validated currency. Mixed-currency groups fail closed and produce no draft.
The proposal balance is the exact sum of the validated per-AR remaining
balances.

Payment proposals store a deterministic `payment_dedupe_key` for that tuple.
A unique partial index applies only to payment proposals, leaving legacy sales
documents unchanged. Pending, approved, in-flight, sent, cancelled, rejected,
and failed outcomes all retain the same key, preventing another reminder for
that phone and due date. Payment failures do not enter the existing sales
phone-only suppression ledger; the terminal payment proposal itself is the
phone-and-date suppression record.

The source fingerprint is SHA-256 over canonical JSON. AR entries are sorted by
`ar_id`, and each entry contains exactly:

```text
ar_id, current_status, normalized_primary_phone,
amount.value, amount.currency,
credit_applied.value, credit_applied.currency,
exact_local_due_date
```

The sorted AR IDs are also stored explicitly. Canonical field ordering and
normalized numeric serialization make the fingerprint stable across Mongo
document ordering.

## 8. Payment proposal shape

The shared proposal document gains optional payment fields so existing sales
records remain valid:

```text
type: 'sales' | 'payment'
billing_month: 'YYYY-MM' | null
due_date: 'YYYY-MM-DD' | null
referenced_ar_ids: string[]
home_references: string[]
customer_names: string[]
payment_currency: string | null
payment_amount_total: number | null
payment_credit_total: number | null
payment_balance_due: number | null
payment_ar_details: validated per-AR snapshots[]
source_fingerprint: string | null
payment_dedupe_key: string | null
send_not_before: Date | null
verification_state: 'not_verified' | 'verified' | 'blocked' | null
verified_at: Date | null
verification_error: string | null
cancelled_at: Date | null
cancelled_reason: string | null
```

`cancelled` is added as an auditable terminal proposal status. A rejected
Payment draft also uses `cancelled`, with a human reason and actor recorded;
legacy sales `skipped` behavior remains unchanged.

`send_not_before` is the UTC instant corresponding to 00:00 on the exact due
date in `Asia/Phnom_Penh`. Storing both this instant and the local date string
makes the claim gate efficient and the audit display unambiguous.

## 9. Template and approval modes

Payment Tracker uses a separately editable template. Supported placeholders
are:

```text
{{customer_name}}, {{customer_names}}, {{ar_references}},
{{home_references}}, {{amount_due}}, {{currency}}, {{due_date}}
```

All rendered values come from validated source fields. Multiple names and
references are deterministic, de-duplicated lists; no missing value is
invented. Rendering failure blocks draft creation.

Saving edited wording invalidates its prior approval. An explicit “Approve
wording” action records approver and timestamp. Payment scanning and enabling
Payment Auto are blocked until non-empty wording has current approval.
Company/Personal templates retain existing behavior.

Payment Manual is the default. It creates `pending` drafts. Enabling Payment
Auto updates only the Payment Tracker worker-state document, approves all
existing Payment Pending drafts, and automatically approves future eligible
drafts. Disabling Auto does not revoke already valid approvals unless a live
source change requires it.

## 10. Claim-time verification

Company and Personal retain their current claim algorithm. Payment Tracker uses
an additional service invoked by the same claim endpoint after strict org
validation:

1. Atomically acquire a short verification lease on one approved Payment
   proposal whose `send_not_before <= now`. Concurrent workers cannot verify or
   claim the same proposal.
2. Reread every `referenced_ar_id` from `ar_state` and also read the eligible
   source candidates for that proposal's exact due date. The latter detects ARs
   newly joining or leaving the phone-and-date group.
3. Apply the same strict normalization, status, phone, date, money, currency,
   grouping, and fingerprint rules used by the scanner.
4. If every referenced AR is paid, cancelled, written off, missing,
   currency-invalid, or has no positive remaining balance, transition the
   proposal to `cancelled` with a machine-readable reason and audit timestamp.
5. If the source remains eligible but status, primary phone, money, due date,
   or group membership changed, rebuild the proposal and fingerprint.
   - When its dedupe boundary is unchanged, refresh the same proposal.
   - When phone or due date changes, cancel the old proposal as superseded and
     upsert the new boundary without losing the audit trail.
   - In Manual mode, clear approval and return the refreshed proposal to
     `pending`.
   - In Auto mode, keep it automatically approved, subject to the new due-date
     gate and another live verification.
6. If the source and fingerprint are unchanged, atomically compare the
   proposal ID, exact organization, status, verification lease, and fingerprint
   before transitioning it to `in_flight` and returning it to the worker.

Mongo outages, incomplete reads, malformed records, unknown statuses, or mixed
currencies never produce a claim. The proposal records `verification_state =
'blocked'`, retains an auditable safe error code, and receives a bounded retry
time so one bad record cannot hot-loop or starve the queue. No partial live
verification is accepted.

Expired verification leases are recoverable. Existing in-flight lease behavior
remains unchanged after a successfully verified payment claim.

## 11. Worker API isolation

The following operations require the explicit worker organization and scope
every read/write by both proposal ID and that organization:

- claim
- effective media manifest and individual proposal media
- mark sent
- mark failed

The claim response contains only a proposal from the strict worker org. Media
lookup first proves proposal ownership. Mark-sent and mark-failed return not
found for a foreign proposal and perform no state, cap, suppression, or alert
mutation.

The worker process no longer silently supplies Company when `ORG_ID` is
missing; it exits before network activity. Existing PM2 entries already set
Company and Personal explicitly, so their normal behavior is unchanged.

## 12. Cap semantics

Payment Tracker uses `PAYMENT_TRACKER_DAILY_CAP`, default `15`. The cap is
independent of Company and Personal and is enforced server-side with atomic
delivery reservations so concurrent Payment workers cannot exceed 15
successful deliveries. A reservation is finalized on mark-sent and released
on mark-failed or an expired claim lease. Company/Personal retain their current
cap implementation.

The Payment worker also receives a local cap of 15 as defense in depth, but the
server is authoritative.

## 13. UI

Payment Tracker appears beside Company and Personal in workspace navigation.
Its outreach view reuses Pending, Approved, In Flight, Sent, Failed, and
Cancelled workflow tabs while showing Payment-specific controls and fields:

- source connection/last scan state without credentials;
- approved payment template and supported placeholders;
- independent Manual/Auto toggle;
- due date and billing month;
- referenced AR and home IDs;
- per-AR amount, credit, currency, and remaining balance;
- combined validated balance;
- source fingerprint and last verification time/state;
- send-not-before gate and cancellation reason.

Sales-only generation controls and sales reasoning fields are hidden in the
Payment workspace. Payment drafts remain message-editable in Pending, but a
live source change still invalidates Manual approval regardless of prior edits.

## 14. Telegram session and PM2 operations

Only `telegram-string-session-payment-tracker.txt` may be created by the new
payment login command. The command:

- forces `ORG_ID=payment_tracker`;
- resolves and compares the absolute output path;
- refuses Company, Personal, arbitrary, or symlinked session paths;
- refuses to overwrite an existing file;
- writes with restrictive permissions using the existing GramJS login flow.

A separate Payment-only PM2 configuration defines
`outreach-worker-payment-tracker`, the exact payment session path, explicit org,
unique worker ID, and local cap 15. It is not added to the existing two-worker
start command. Provisioning does not alter Company/Personal session files or
process definitions.

The new worker uses the existing MTProto contact lookup, message/media send,
inbound listener, heartbeat, and failure reporting code unchanged.

## 15. Configuration

```text
PAYMENT_TRACKER_DATABASE_URL=<read-only URI for ar_tracker only>
PAYMENT_TRACKER_SCAN_ENABLED=false
PAYMENT_TRACKER_SCAN_TIME=10:00
PAYMENT_TRACKER_DAILY_CAP=15
```

The shared `AGENT_TOKEN` remains in use. Organization isolation is enforced
server-side and is not inferred from the token.

## 16. Verification

Automated tests cover:

- Cambodia end-of-tomorrow and local-midnight boundaries;
- BSON `Date` conversion to exact local date and `send_not_before`;
- first-valid-phone selection while preserving source order;
- missing/malformed money, currency mismatch, and positive balance math;
- phone-and-date grouping, mixed-currency rejection, and deterministic sums;
- deduplication and fingerprint stability/order sensitivity;
- Manual and Auto draft/refresh behavior;
- due-date claim gating and successful live verification;
- paid-before-send cancellation;
- status, phone, amount, credit, due-date, and membership changes;
- outages, incomplete reads, malformed records, and unknown statuses;
- concurrent Payment claims and cap reservations;
- failed-send alert and phone/date suppression behavior;
- rejection/cancellation audit fields;
- missing/invalid worker org rejection;
- foreign-org claim, media, mark-sent, and mark-failed denial.

Before any confidence claim, run the existing Company/Personal scheduler,
claim, cap, media, heartbeat, inbound-reply, and organization-isolation checks,
plus TypeScript build/typecheck. Existing database-backed check scripts must use
isolated test records and clean them up without touching unrelated data.

The rollout check reruns `listIndexes()` and `explain('executionStats')` using
the read-only credential. Missing or unsuitable index coverage is reported to
the Payment Tracker administrator as a blocker or performance risk; audit-sales
never attempts to repair it.

## 17. Staged rollout

1. Deploy code with `PAYMENT_TRACKER_SCAN_ENABLED=false` and no Payment worker.
2. Verify the source URI authenticates with only `read` on `ar_tracker`, can
   read `ar_state`, and cannot administer or write through its assigned roles.
3. Re-run schema, date-type, phone/credit readiness, index, and explain checks.
4. Configure and explicitly approve Payment wording.
5. Generate only `telegram-string-session-payment-tracker.txt` with the guarded
   login command.
6. Set the Payment worker state to paused, start the separate PM2 app, and prove
   its heartbeat is isolated.
7. Test a controlled due-today proposal that becomes paid before claim and
   confirm auditable cancellation with no Telegram send.
8. Enable Manual scanning and review early drafts operationally.
9. Enable Payment Auto only after stakeholder acceptance.

Current source data with null phone or credit fields remains a data-readiness
blocker for actual reminder creation even after the credential is corrected.

## 18. Explicitly replaced assumptions

This revision supersedes the prior design's HTTP endpoint, integration token,
mirrored LeadEvent customer model, `home_id` primary key, monthly
deduplication, global cap redesign, and generic sales auto-drafting. The source
of truth is direct read-only `ar_state`; `ar_id` is the receivable identity;
deduplication is exact phone plus local due date; and Payment scanning and
claim-time verification are purpose-built while the sales pipeline remains
explicitly limited to Company and Personal.
