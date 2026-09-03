/**
 * Strict worker configuration.
 *
 * The worker previously defaulted ORG_ID to 'company'. With two workspaces that
 * was merely sloppy; with a third it is dangerous — a Payment worker started
 * without ORG_ID, or with a typo, would claim Company proposals and send them
 * from the payment Telegram account. So the org is now required and validated
 * before any network activity, and the process exits rather than guessing.
 *
 * The list is duplicated from src/outreach/orgs.ts rather than imported: this
 * worker is a separate package with its own node_modules and no build step that
 * reaches into src/. Keep the two in sync when adding a workspace.
 */
export const WORKER_ORG_IDS = ['company', 'personal', 'payment_tracker'] as const;

export type WorkerOrgId = (typeof WORKER_ORG_IDS)[number];

export function requireWorkerOrgId(value: unknown): WorkerOrgId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `ORG_ID must be explicitly set to one of: ${WORKER_ORG_IDS.join(', ')}`
    );
  }
  if (!WORKER_ORG_IDS.includes(value as WorkerOrgId)) {
    throw new Error(`invalid ORG_ID "${value}" — expected one of: ${WORKER_ORG_IDS.join(', ')}`);
  }
  return value as WorkerOrgId;
}
