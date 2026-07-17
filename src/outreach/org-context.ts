/**
 * Resolve the "active org" for a request.
 *
 * Two kinds of callers:
 *   - Dashboard/browser — carries the `outreach_org` cookie set by the org
 *     switcher. Falls back to DEFAULT_ORG when absent.
 *   - Worker/agent — the gramjs send-loop declares its org on every call via the
 *     `X-Org-Id` header (its `ORG_ID` env). A `?org=` query param is also
 *     honoured (worker GETs that can't set a body easily, and manual testing).
 *
 * Precedence: explicit header/query wins over the cookie, so a worker is never
 * misrouted by a stray browser cookie. Anything invalid coerces to DEFAULT_ORG.
 * The shared AGENT_TOKEN is unchanged — org is a routing dimension, not an auth
 * boundary (single-operator trust model; per-org tokens are a later hardening).
 */

import { Request } from 'express';
import { parseCookies } from '../api/auth-middleware';
import { OrgId, normalizeOrg } from './orgs';

export const ORG_COOKIE_NAME = 'outreach_org';
export const ORG_HEADER_NAME = 'x-org-id';

export function resolveOrg(req: Request): OrgId {
  const header = req.headers[ORG_HEADER_NAME];
  if (typeof header === 'string' && header) return normalizeOrg(header);

  const queryOrg = req.query?.org;
  if (typeof queryOrg === 'string' && queryOrg) return normalizeOrg(queryOrg);

  const bodyOrg = (req.body && typeof req.body === 'object') ? (req.body as Record<string, unknown>).org : undefined;
  if (typeof bodyOrg === 'string' && bodyOrg) return normalizeOrg(bodyOrg);

  const cookies = parseCookies(req.headers.cookie);
  return normalizeOrg(cookies[ORG_COOKIE_NAME]);
}
