# Editable Default Outreach Text — Design

**Date:** 2026-07-16
**Status:** Approved (pending spec review)

## Problem

The outreach page (`/crm/outreach`) already lets operators change the **default
brand image** (stored in Mongo) and the **default marketing video** (stored in
R2). The third piece of a proposal — the **message text** — is not editable from
the UI. It is the static Khmer caption hardcoded in
`src/outreach/static-template.ts` (`DEFAULT_STATIC_MESSAGE`), with an
`OUTREACH_STATIC_MESSAGE` env override. Changing it today requires a code or env
change and a redeploy.

This feature makes the default text editable and persistent, presented alongside
the existing default-image and default-video controls on the same page.

## Scope

In scope:
- Persist an operator-edited default outreach message in the database.
- Add a "Default text" card to `/crm/outreach` (textarea + Save + Reset to default).
- Route the generator to use the persisted value.

Out of scope (YAGNI):
- Per-follower or per-campaign templates.
- Template variables / placeholders.
- A separate settings page (decided: keep on the Outreach page).
- Editing already-generated proposals (they keep the text copied at generation time).

## Decisions (signed off)

1. **Precedence:** DB value → `OUTREACH_STATIC_MESSAGE` env → hardcoded
   `DEFAULT_STATIC_MESSAGE`. The UI edit is the source of truth; env and the
   constant are fallbacks for a fresh deploy with no saved value.
2. **Effect timing:** editing the default text affects only **newly generated**
   proposals. Existing pending/approved proposals are unchanged — the message is
   copied onto each proposal at generation time.
3. **Placement:** a third card on `/crm/outreach`, next to the image/video cards.
4. **Auth:** same as the existing media routes — `authMiddleware` only, no extra
   role gate.

## Components

### 1. `OutreachSettingsRepository` (new)

File: `src/outreach/outreach-settings-repository.ts`

- Mongo collection `outreach_settings`, singleton doc `_id: 'default'`.
- Fields: `static_message: string`, `updated_at: Date`, `updated_by: string`.
- Methods:
  - `getStaticMessage(): Promise<string | null>` — returns the saved message, or
    `null` if none saved.
  - `setStaticMessage(text: string, updatedBy: string): Promise<void>` — upsert.
  - `clearStaticMessage(): Promise<void>` — delete the doc (revert to fallback).
- Mirrors the singleton-doc pattern of `OutreachVideoRepository`.

### 2. `static-template.ts` — resolver

- `getStaticOutreachMessage()` becomes **async**:
  ```
  export async function getStaticOutreachMessage(): Promise<string> {
    try {
      const saved = await new OutreachSettingsRepository().getStaticMessage();
      if (saved && saved.trim()) return saved.trim();
    } catch (err) {
      Logger.warn(`getStaticOutreachMessage DB read failed: ${(err as Error).message}`);
    }
    return process.env.OUTREACH_STATIC_MESSAGE?.trim() || DEFAULT_STATIC_MESSAGE;
  }
  ```
- `DEFAULT_STATIC_MESSAGE` is exported so the route can return it as the "reset
  target" preview.
- DB read failure logs a warning and falls back — generation never breaks
  (matches the worker's "half-configured never fails a send" philosophy).

### 3. `outreach-agent.ts` — generator

- Resolve the message **once** before the candidate loop:
  `const staticMessage = await getStaticOutreachMessage();`
- Use `staticMessage` for each inserted proposal's `message` field (replaces the
  current inline `getStaticOutreachMessage()` call at line ~100).
- Only call site of the function, so no other callers need updating.

### 4. `outreach-routes.ts` — API

Three new routes, `authMiddleware` only (already applied router-wide):

- `GET /default-text`
  - Returns `{ message, is_custom, updated_at, updated_by, default_message }`.
  - `message` = effective text (same resolution as the generator).
  - `is_custom` = true when a DB value is set.
  - `default_message` = hardcoded `DEFAULT_STATIC_MESSAGE` (for the reset preview).
- `POST /default-text` (JSON `{ message }`)
  - Validate: `message` is a string, `trim()` non-empty, length ≤ 4096.
    - Empty/whitespace → 400 `{ error: 'message required' }`.
    - Over 4096 → 400 `{ error: 'message exceeds 4096 characters' }`.
  - `setStaticMessage(message.trim(), getSessionUser(req) || 'unknown')`.
  - Log the change (who + length), return `{ ok: true }`.
- `DELETE /default-text`
  - `clearStaticMessage()`, return `{ ok: true }`. Effective text reverts to
    env/hardcoded on next read.

### 5. `outreach.hbs` — UI

A third card matching the `.default-image-card` style, placed after the
default-video card:

- A `<textarea>` prefilled with the effective message.
- A char counter reusing the existing `counterClass()` thresholds
  (green ≤1024, yellow ≤4096, red >4096).
- **Save** button — POSTs the textarea value; disabled when empty or >4096.
- **Reset to default** button — DELETEs, then reloads the effective (fallback)
  text into the textarea.
- A muted note: "Applies to newly generated proposals."
- On page init, `refreshDefaultText()` runs alongside `refreshDefaultImage()` /
  `refreshDefaultVideo()`.

## Data flow

```
Operator edits textarea → POST /default-text
   → OutreachSettingsRepository.setStaticMessage → outreach_settings doc

Generate batch → outreach-agent → await getStaticOutreachMessage()
   → OutreachSettingsRepository.getStaticMessage (DB) OR env OR constant
   → copied onto each new proposal.message
```

## Error handling

- Invalid input (empty / >4096) → 400 with a specific message; Save is also
  disabled client-side in those states.
- DB read failure in the resolver → warn + fall back to env/hardcoded.
- DB write failure in POST → 500 (standard route error handling), toast on client.

## Testing

- **Unit:**
  - `OutreachSettingsRepository` get/set/clear round-trips.
  - Resolver precedence: DB > env > default; empty DB value ignored;
    DB-read-failure falls back without throwing.
- **Manual:**
  - Edit text → Save → Generate batch → a new proposal carries the new text.
  - Reset to default → textarea reverts; a subsequent Generate uses the fallback.
  - Existing pending proposals are unchanged after an edit.
