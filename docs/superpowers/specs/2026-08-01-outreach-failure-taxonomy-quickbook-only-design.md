# Outreach: failure taxonomy + QuickBook-only targeting

Date: 2026-08-01
Status: approved for implementation

## Problem

Two defects, both observed live on 2026-08-01.

**1. Failed numbers outrank fresh ones.** `outreach-routes.ts:759` writes a
`leads_events` row only on a *successful* send. Candidate selection sorts
`last_update_date: 1` (oldest first, `aggregations.ts:313`). A failed attempt
therefore records nothing, the number keeps its old date, and it is picked
*first* again next run. 90 of the 681 numbers eligible tomorrow have already
failed; 591 have never been tried and keep losing the sort.

The daily ceiling is `DEFAULT_ATTEMPT_CAP = 40` ImportContacts lookups
(`outreach-routes.ts:32`), not the 15 deliveries. On 2026-08-01, 35 of 40
lookups were spent on numbers that could not receive, delivering 5 messages.

**2. Failure kinds are conflated.** `transient` currently covers both a pm2
outage (our infrastructure) and Telegram refusing an import (their side). They
need opposite treatment: our own outage must never penalise a customer, while a
refused import must take the number out of rotation.

## Design

### Failure taxonomy

Every failure resolves to exactly one kind. Only `deferred` is new.

| Cause | Kind | Effect on the number |
|---|---|---|
| Not on Telegram / hidden by privacy | `privacy` | Permanent park (unchanged) |
| Malformed number | `invalid` | Permanent park (unchanged) |
| Import refused (`retryContacts`), or send timed out | `deferred` **(new)** | Set aside `DEFERRED_COOLDOWN_DAYS`, then eligible |
| pm2 down, lease expired, worker crash | `transient` | **No penalty** — our fault |
| Delivered | `contacted` | 180-day cooldown (unchanged) |

`deferred` reuses the `eligible_again_at` mechanism that already backs the
`contacted` cooldown, and `getSuppressedPhones()` already honours it. No new
collection.

`DEFERRED_COOLDOWN_DAYS` defaults to **30**, overridable by env.

Classification is by reason string in `classifyFailure()`. Order matters —
`invalid` before `privacy` before `deferred`, `transient` as the fallback so an
unrecognised reason never parks a customer.

Reason strings that map to `deferred`:
- `contact import deferred by Telegram (retry later)` (`DEFERRED_IMPORT_REASON`)
- `exception: send timed out after Ns`

### QuickBook-only targeting

Candidate selection is restricted to phones with at least one lead event whose
`source.model === 'csv-import'` — the QuickBook/spreadsheet import.

Today this is already true of 325 of 337 phones ever proposed, but it is a
coincidence of pool composition, not a rule: `selectCandidates`
(`outreach-agent.ts:59`) applies no source filter. This makes it explicit so
Telegram-decoded and worker-written leads can never be targeted.

**The filter must be opt-in.** `getStaleCustomers` has three callers, and only
one is outreach:

| Caller | Behaviour |
|---|---|
| `bot/commands/crm-command.ts:85` (`/crm`) | unchanged — all customers |
| `api/crm-routes.ts:165` (dashboard stale view) | unchanged — all customers |
| `outreach/outreach-agent.ts:59` | QuickBook only |

`buildStaleCustomersPipeline` therefore takes a `quickBookOnly` parameter
defaulting to `false`, and `getStaleCustomers` an `opts.quickBookOnly`.
Filtering unconditionally would silently hide Telegram-sourced customers from
the operator's own reports — a reporting regression nobody asked for.

Sending still uses `contacts.ImportContacts`. It is the only API that reaches a
non-contact; `contacts.ResolvePhone` returns `PHONE_NOT_OCCUPIED` for
privacy-restricted users and was verified on 2026-08-01 to fail on 6 of 8
numbers this account had provably delivered to. This spec changes *which numbers
are targeted*, not *how they are reached*.

### Backfill

The 69 suppressions resolved by `unblock-deferred-privacy.js` earlier today are
re-flagged `deferred` with `eligible_again_at = now + DEFERRED_COOLDOWN_DAYS`.
They are set aside, not written off: if the 2026-07-30..08-01 throttle theory
holds they return healthy; if they are genuinely dead they fail again and park
permanently.

## Components

| File | Change |
|---|---|
| `src/outreach/outreach-suppression-repository.ts` | Add `deferred` to `SuppressionKind`; classify the two reason strings; set `eligible_again_at`; add to `KIND_PRIORITY` below `privacy`; include in the suppressing set only while `eligible_again_at > now` |
| `src/database/aggregations.ts` | `buildStaleCustomersPipeline` gains an **opt-in** `quickBookOnly` param (`import_models: 'csv-import'`, matching `buildQuickBookCustomersPipeline`), default `false` |
| `src/database/repository.ts` | `getStaleCustomers` gains `opts.quickBookOnly` |
| `src/outreach/outreach-agent.ts` | `selectCandidates` passes `quickBookOnly: true` — the only caller that does |
| `scripts/park-deferred-69.js` | One-off backfill, dry-run by default |

`classifyFailure` stays the single source of truth for kind. No caller decides
permanence on its own.

## Error handling

- Unknown reason → `transient` (no penalty). Never park on an unrecognised failure.
- A `deferred` failure on a phone inside an active `contacted` cooldown must not
  shorten that cooldown — the existing clock guard in `recordFailure` covers this.
- `KIND_PRIORITY`: `contacted(0) < transient(1) < deferred(2) < privacy(3) < invalid(4)`.
  A real refusal outranks a deferral; a deferral outranks our own outage.

## Testing

Extends `scripts/check-failure-routing.js` (existing PASS/FAIL idiom, scratch DB):

1. `classifyFailure(DEFERRED_IMPORT_REASON)` → `deferred`
2. `classifyFailure('exception: send timed out after 240s')` → `deferred`
3. `classifyFailure('lease expired without resolution (3rd attempt)')` → `transient`
4. A `deferred` failure sets `eligible_again_at` ≈ now + N days, and
   `next_retry_at` is not null (it is not a permanent park)
5. `getSuppressedPhones()` excludes the phone while inside the window and
   includes it again once `eligible_again_at` has passed
6. A `transient` failure sets no `eligible_again_at` — pm2 downtime never parks
7. An active `contacted` cooldown survives a stray `deferred` failure

Plus `scripts/check-quickbook-only.js`, which must prove both directions:

- outreach path (`quickBookOnly: true`) — `csv-import` phone appears, a
  `bulk-telegram`-only phone never does
- CRM default (no flag) — the `bulk-telegram` phone **still appears**, proving
  reporting is untouched

## Out of scope

- Why Telegram defers these imports (unresolved; see session 2026-08-01)
- The QuickBook display-shadowing issue in `buildQuickBookCustomersPipeline`
- Pruning the 6,521-entry address book
