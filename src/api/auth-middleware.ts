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
 * Create a session cookie value with expiry.
 */
export function createSessionCookie(secret: string): string {
  const expires = Date.now() + SESSION_DURATION_MS;
  return signValue(`session:${expires}`, secret);
}

/**
 * Verify session cookie is valid and not expired.
 */
function isValidSession(cookie: string, secret: string): boolean {
  const value = verifySignedValue(cookie, secret);
  if (!value) return false;
  const parts = value.split(':');
  if (parts[0] !== 'session') return false;
  const expires = parseInt(parts[1], 10);
  return !isNaN(expires) && Date.now() < expires;
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
    if (parts.length === 2 && parts[0] === 'Bearer' && parts[1] === token) {
      next();
      return;
    }
  }

  // 3. Redirect to login page (for browser navigation)
  if (req.accepts('html') && !req.path.startsWith('/api/')) {
    const loginPath = req.baseUrl + '/login';
    if (req.path !== '/login') {
      res.redirect(loginPath);
      return;
    }
  }

  res.status(401).json({ error: 'Unauthorized' });
}
