import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { Logger } from '../utils/logger';

const COOKIE_NAME = 'audit_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type Role = 'developer' | 'manager' | 'agent';

/**
 * Sign a value with DASHBOARD_TOKEN as secret.
 */
function signValue(value: string, secret: string): string {
  const signature = crypto.createHmac('sha256', secret).update(value).digest('hex');
  return `${value}.${signature}`;
}

/**
 * Verify a signed value. Returns the value if valid, null otherwise.
 */
function verifySignedValue(signed: string, secret: string): string | null {
  const lastDot = signed.lastIndexOf('.');
  if (lastDot === -1) return null;
  const value = signed.slice(0, lastDot);
  const expected = signValue(value, secret);
  if (signed === expected) return value;
  return null;
}

/**
 * Create a session cookie value with expiry. Signed with DASHBOARD_TOKEN.
 */
export function createSessionCookie(username: string): string {
  const secret = process.env.DASHBOARD_TOKEN;
  if (!secret) throw new Error('DASHBOARD_TOKEN not configured');
  const expires = Date.now() + SESSION_DURATION_MS;
  return signValue(`session:${username}:${expires}`, secret);
}

/**
 * Verify session cookie is valid and not expired.
 * Claim format: session:<username>:<expires>
 */
function isValidSession(cookie: string, secret: string): boolean {
  const value = verifySignedValue(cookie, secret);
  if (!value) return false;
  const parts = value.split(':');
  if (parts.length !== 3 || parts[0] !== 'session') return false;
  const expires = parseInt(parts[2], 10);
  return !isNaN(expires) && Date.now() < expires;
}

let warnedDeprecatedWorkerToken = false;
let warnedAgentEqualsDashboard = false;
let warnedWorkerEqualsDashboard = false;

/**
 * Map a Bearer token to a role.
 *
 *   DASHBOARD_TOKEN → 'developer' (admin Bearer; same authority as the
 *                     logged-in developer cookie).
 *   AGENT_TOKEN     → 'agent'     (restricted to outreach send-loop endpoints
 *                     via the allowlist in authMiddleware).
 *   WORKER_TOKEN    → 'agent'     (legacy alias; logs a one-shot deprecation
 *                     warning the first time it matches).
 *
 * If AGENT_TOKEN or WORKER_TOKEN is set to the same value as DASHBOARD_TOKEN
 * we fail safe — return 'developer' rather than 'agent', so a misconfigured
 * deployment never silently grants the worker process restricted-only routes
 * it would otherwise have full access to. A loud warning is logged once.
 */
export function bearerRole(token: string): Role | null {
  const dashboard = process.env.DASHBOARD_TOKEN;
  if (dashboard && token === dashboard) return 'developer';

  const agent = process.env.AGENT_TOKEN;
  if (agent && token === agent) {
    if (dashboard && agent === dashboard) {
      if (!warnedAgentEqualsDashboard) {
        Logger.warn('AGENT_TOKEN equals DASHBOARD_TOKEN — refusing to downgrade to agent role. Set AGENT_TOKEN to a distinct random value.');
        warnedAgentEqualsDashboard = true;
      }
      return 'developer';
    }
    return 'agent';
  }

  const worker = process.env.WORKER_TOKEN;
  if (worker && token === worker) {
    if (dashboard && worker === dashboard) {
      if (!warnedWorkerEqualsDashboard) {
        Logger.warn('WORKER_TOKEN equals DASHBOARD_TOKEN — refusing to downgrade to agent role. Set AGENT_TOKEN to a distinct random value.');
        warnedWorkerEqualsDashboard = true;
      }
      return 'developer';
    }
    if (!warnedDeprecatedWorkerToken) {
      Logger.warn('WORKER_TOKEN is deprecated — rename to AGENT_TOKEN.');
      warnedDeprecatedWorkerToken = true;
    }
    return 'agent';
  }

  return null;
}

/**
 * Extract the signed-in role from a request.
 *   - Cookie session → 'developer' or 'manager' (whatever the login form set)
 *   - Bearer token   → 'developer' or 'agent' (see bearerRole)
 *   - otherwise null
 */
export function getSessionUser(req: Request): Role | null {
  const secret = process.env.DASHBOARD_TOKEN;
  if (!secret) return null;

  const cookies = parseCookies(req.headers.cookie);
  const signed = cookies[COOKIE_NAME];
  if (signed) {
    const value = verifySignedValue(signed, secret);
    if (value) {
      const parts = value.split(':');
      if (parts.length === 3 && parts[0] === 'session') {
        const expires = parseInt(parts[2], 10);
        if (!isNaN(expires) && Date.now() < expires) {
          const username = parts[1];
          if (username === 'developer' || username === 'manager') return username;
          return null;
        }
      }
    }
  }

  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      return bearerRole(parts[1]);
    }
  }

  return null;
}

/**
 * Parse cookies from request header.
 */
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  cookieHeader.split(';').forEach(pair => {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key.trim()] = decodeURIComponent(rest.join('='));
  });
  return cookies;
}

/**
 * Endpoints the 'agent' role is allowed to call. Everything not on this
 * list returns 403 for agent. Source of truth: `src/api/outreach-routes.ts`.
 *
 * Patterns match the absolute path (`req.baseUrl + req.path`), so this
 * works whether authMiddleware is mounted on the app or on a sub-router.
 */
const AGENT_ALLOWED: Array<{ method: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\/crm\/api\/outreach\/claim$/ },
  { method: 'POST', pattern: /^\/crm\/api\/outreach\/[A-Za-z0-9_-]+\/mark-sent$/ },
  { method: 'POST', pattern: /^\/crm\/api\/outreach\/[A-Za-z0-9_-]+\/mark-failed$/ },
  { method: 'POST', pattern: /^\/crm\/api\/outreach\/worker-heartbeat$/ },
  { method: 'POST', pattern: /^\/crm\/api\/outreach\/worker-alert$/ },
  { method: 'POST', pattern: /^\/crm\/api\/outreach\/report-inbound$/ },
  { method: 'GET',  pattern: /^\/crm\/api\/outreach\/worker-status$/ },
];

function isAgentAllowed(req: Request): boolean {
  const fullPath = (req.baseUrl || '') + req.path;
  return AGENT_ALLOWED.some((entry) => entry.method === req.method && entry.pattern.test(fullPath));
}

/**
 * Auth middleware — checks session cookie or Bearer token. For Bearer
 * tokens that resolve to the 'agent' role, additionally enforces the
 * path allowlist above.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.DASHBOARD_TOKEN;

  if (!token) {
    res.status(500).json({ error: 'DASHBOARD_TOKEN not configured' });
    return;
  }

  // 1. Check session cookie
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME] && isValidSession(cookies[COOKIE_NAME], token)) {
    next();
    return;
  }

  // 2. Check Authorization: Bearer <token> header (for API calls)
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      const role = bearerRole(parts[1]);
      if (role === 'developer') {
        next();
        return;
      }
      if (role === 'agent') {
        if (isAgentAllowed(req)) {
          next();
          return;
        }
        res.status(403).json({ error: 'agent role not authorized for this path' });
        return;
      }
    }
  }

  // 3. Redirect to login page (for browser navigation)
  if (req.accepts('html') && !req.path.startsWith('/api/')) {
    res.redirect('/login');
    return;
  }

  res.status(401).json({ error: 'Unauthorized' });
}
