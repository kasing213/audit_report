/**
 * Outreach org registry.
 *
 * The app runs two fully-separate outreach workspaces under one dashboard:
 * `company` (the default — sales-group ingestion + daily reports always belong
 * here) and `personal`. Each org has its own sending Telegram number, its own
 * daily caps/worker state, its own default message/image/video, and its own
 * imported customer data. This module is the single source of truth for the org
 * ids; everything else threads an `orgId` string through.
 *
 * Two static orgs is deliberate — no orgs collection. Adding a third later means
 * appending to OUTREACH_ORGS (and standing up a third worker/session).
 */

export type OrgId = string;

export interface OrgDef {
  id: OrgId;
  label: string;
}

export const DEFAULT_ORG: OrgId = 'company';

export const OUTREACH_ORGS: OrgDef[] = [
  { id: 'company', label: 'Company' },
  { id: 'personal', label: 'Personal' },
];

const ORG_IDS = new Set(OUTREACH_ORGS.map((o) => o.id));

export function isValidOrg(value: unknown): value is OrgId {
  return typeof value === 'string' && ORG_IDS.has(value);
}

/**
 * Coerce arbitrary input to a valid org id, falling back to DEFAULT_ORG.
 */
export function normalizeOrg(value: unknown): OrgId {
  return isValidOrg(value) ? value : DEFAULT_ORG;
}

export function orgLabel(id: OrgId): string {
  return OUTREACH_ORGS.find((o) => o.id === id)?.label ?? id;
}

/**
 * `_id` for an org's singleton "default branding" doc (message / image / video).
 * Pre-multi-org docs used the bare `'default'`; scripts/backfill-org-company.js
 * re-keys those to defaultDocKey('company').
 */
export function defaultDocKey(orgId: OrgId): string {
  return `default:${orgId}`;
}

/**
 * The value to match against an `org_id` field in a Mongo filter. Documents
 * written before this feature (and all company-owned ingestion) have no
 * `org_id`, so the default org additionally matches missing/null. Any other org
 * matches its exact id only.
 *
 *   { org_id: orgMatch('company') }  → { org_id: { $in: [null, 'company'] } }
 *   { org_id: orgMatch('personal') } → { org_id: 'personal' }
 */
export function orgMatch(orgId: OrgId): OrgId | { $in: Array<OrgId | null> } {
  if (orgId === DEFAULT_ORG) return { $in: [null, orgId] };
  return orgId;
}
