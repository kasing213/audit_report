/**
 * Pre-rollout inspection of the Payment Tracker source credential and schema.
 *
 * This exists because connecting to ar_state with the wrong credential is the
 * single most dangerous thing this feature can do. The supplied Payment-Tracker
 * URI authenticates as atlasAdmin; that must never be copied here. Deployment
 * is gated on a custom role limited to find + listIndexes on exactly one
 * namespace, and validateSourcePrivileges() is what proves it.
 *
 * Every value returned is redacted metadata — role and privilege shapes, field
 * types, index names, plan summary, and counts. Never a URI, phone number,
 * customer name, home id, or ar_id.
 */

export const SOURCE_DB = 'ar_tracker';
export const SOURCE_COLLECTION = 'ar_state';

/** The complete set of actions the source credential may hold. */
const ALLOWED_ACTIONS = ['find', 'listIndexes'];

/** Actions the inspection itself needs, so a find-only role is still rejected. */
const REQUIRED_ACTIONS = ['find', 'listIndexes'];

export type PrivilegeCheck = { ok: true } | { ok: false; reason: string };

/**
 * Accept a privilege set only if every entry targets exactly
 * ar_tracker.ar_state and grants nothing beyond find + listIndexes.
 *
 * An empty `collection` means database-wide, which is what MongoDB's built-in
 * `read` role grants — broader than required, so it is rejected rather than
 * tolerated. A `cluster`/`anyResource` entry is rejected for the same reason.
 */
export function validateSourcePrivileges(privileges: unknown): PrivilegeCheck {
  if (!Array.isArray(privileges) || privileges.length === 0) {
    return { ok: false, reason: 'no privileges reported for the source credential' };
  }

  const granted = new Set<string>();

  for (const entry of privileges) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, reason: 'malformed privilege entry' };
    }
    const { resource, actions } = entry as { resource?: unknown; actions?: unknown };

    if (!resource || typeof resource !== 'object') {
      return { ok: false, reason: 'privilege entry has no resource' };
    }
    const { db, collection } = resource as { db?: unknown; collection?: unknown };

    if (db !== SOURCE_DB || collection !== SOURCE_COLLECTION) {
      return {
        ok: false,
        reason: `privilege targets ${describeResource(resource)} — only ${SOURCE_DB}.${SOURCE_COLLECTION} is permitted`,
      };
    }

    if (!Array.isArray(actions) || actions.length === 0) {
      return { ok: false, reason: 'privilege entry grants no actions' };
    }

    for (const action of actions) {
      if (typeof action !== 'string' || !ALLOWED_ACTIONS.includes(action)) {
        return { ok: false, reason: `disallowed action: ${String(action)}` };
      }
      granted.add(action);
    }
  }

  const missing = REQUIRED_ACTIONS.filter((action) => !granted.has(action));
  if (missing.length > 0) {
    return { ok: false, reason: `missing required action(s): ${missing.join(', ')}` };
  }

  return { ok: true };
}

/** Describe a resource for an error message without leaking anything sensitive. */
function describeResource(resource: object): string {
  const { db, collection, cluster, anyResource } = resource as Record<string, unknown>;
  if (cluster === true) return 'the cluster';
  if (anyResource === true) return 'any resource';
  const dbLabel = typeof db === 'string' && db.length > 0 ? db : '<all databases>';
  const colLabel = typeof collection === 'string' && collection.length > 0 ? collection : '<all collections>';
  return `${dbLabel}.${colLabel}`;
}

/**
 * The richer read surface inspection needs. Kept separate from
 * PaymentReadCollection on purpose: candidate reads must never be handed an
 * object that can run arbitrary commands, even read-only ones.
 */
export interface PaymentInspectionPort {
  /** db.runCommand — only ever called with connectionStatus here. */
  command(spec: Record<string, unknown>): Promise<Record<string, unknown>>;
  listIndexes(): Promise<Array<Record<string, unknown>>>;
  /** explain('executionStats') of the production candidate query. */
  explainCandidates(cutoff: Date): Promise<Record<string, unknown>>;
  /** Readiness counts only — never the documents themselves. */
  countCandidates(cutoff: Date): Promise<number>;
  countMissingPhone(cutoff: Date): Promise<number>;
  countMissingCredit(cutoff: Date): Promise<number>;
}

export interface PaymentSourceReport {
  namespace: string;
  roles: string[];
  privileges: PrivilegeCheck;
  indexNames: string[];
  arIdUniqueIndex: boolean;
  dueDateIsBsonDate: boolean | null;
  winningPlan: string;
  indexUsed: string | null;
  keysExamined: number | null;
  docsExamined: number | null;
  candidateCount: number;
  missingPhoneCount: number;
  missingCreditCount: number;
}

/**
 * Read-only inspection. Returns a redacted report; the calling command decides
 * the exit code. Nothing here writes, and nothing here creates an index — an
 * unsuitable index is reported to the Payment Tracker administrator as a
 * blocker, never repaired from this side.
 */
export async function inspectPaymentSource(
  port: PaymentInspectionPort,
  cutoff: Date
): Promise<PaymentSourceReport> {
  const status = await port.command({ connectionStatus: 1, showPrivileges: true });
  const authInfo = (status.authInfo ?? {}) as Record<string, unknown>;

  const roles = Array.isArray(authInfo.authenticatedUserRoles)
    ? (authInfo.authenticatedUserRoles as Array<Record<string, unknown>>).map(
        (role) => `${String(role.db ?? '?')}:${String(role.role ?? '?')}`
      )
    : [];

  const privileges = validateSourcePrivileges(authInfo.authenticatedUserPrivileges);

  const indexes = await port.listIndexes();
  const indexNames = indexes
    .map((index) => (typeof index.name === 'string' ? index.name : ''))
    .filter((name) => name.length > 0);
  const arIdUniqueIndex = indexes.some(
    (index) => index.unique === true && hasSingleKey(index.key, 'ar_id')
  );

  const explain = await port.explainCandidates(cutoff);
  const plan = extractWinningPlan(explain);

  return {
    namespace: `${SOURCE_DB}.${SOURCE_COLLECTION}`,
    roles,
    privileges,
    indexNames,
    arIdUniqueIndex,
    dueDateIsBsonDate: null,
    winningPlan: plan.stage,
    indexUsed: plan.indexName,
    keysExamined: readNumber(explain, 'executionStats', 'totalKeysExamined'),
    docsExamined: readNumber(explain, 'executionStats', 'totalDocsExamined'),
    candidateCount: await port.countCandidates(cutoff),
    missingPhoneCount: await port.countMissingPhone(cutoff),
    missingCreditCount: await port.countMissingCredit(cutoff),
  };
}

function hasSingleKey(key: unknown, field: string): boolean {
  if (!key || typeof key !== 'object') return false;
  const keys = Object.keys(key as Record<string, unknown>);
  return keys.length === 1 && keys[0] === field;
}

/** Walk to the innermost stage so an IXSCAN under a FETCH is still reported. */
function extractWinningPlan(explain: Record<string, unknown>): { stage: string; indexName: string | null } {
  const queryPlanner = (explain.queryPlanner ?? {}) as Record<string, unknown>;
  let node = (queryPlanner.winningPlan ?? {}) as Record<string, unknown>;
  const stages: string[] = [];
  let indexName: string | null = null;

  while (node && typeof node === 'object') {
    if (typeof node.stage === 'string') stages.push(node.stage);
    if (typeof node.indexName === 'string') indexName = node.indexName;
    const next = (node.inputStage ?? node.queryPlan) as Record<string, unknown> | undefined;
    if (!next) break;
    node = next;
  }

  return { stage: stages.join(' -> ') || 'unknown', indexName };
}

function readNumber(source: Record<string, unknown>, section: string, field: string): number | null {
  const block = source[section];
  if (!block || typeof block !== 'object') return null;
  const value = (block as Record<string, unknown>)[field];
  return typeof value === 'number' ? value : null;
}
