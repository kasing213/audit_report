import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

const COOKIE_NAME = 'audit_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

/**
 * Returns true if the given token matches DASHBOARD_TOKEN, or matches the
 * optional WORKER_TOKEN if it has been configured. The latter lets us hand the
 * worker process a credential that does NOT also unlock the operator UI.
 */
function isValidBearer(token: string): boolean {
  const dashboard = process.env.DASHBOARD_TOKEN;
  if (dashboard && token === dashboard) return true;
  const worker = process.env.WORKER_TOKEN;
  if (worker && token === worker) return true;
  return false;
}

/**
 * Extract the signed-in username from a request's session cookie.
 * Returns 'worker' for Bearer-token requests, null if unauthenticated.
 */
export function getSessionUser(req: Request): string | null {
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
          return parts[1];
        }
      }
    }
  }

  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer' && isValidBearer(parts[1])) {
      return 'worker';
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
 * Auth middleware — checks session cookie, Bearer token, or redirects to login.
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
    if (parts.length === 2 && parts[0] === 'Bearer' && isValidBearer(parts[1])) {
      next();
      return;
    }
  }

  // 3. Redirect to login page (for browser navigation)
  if (req.accepts('html') && !req.path.startsWith('/api/')) {
    res.redirect('/login');
    return;
  }

  res.status(401).json({ error: 'Unauthorized' });
}
