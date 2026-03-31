import { Request, Response, NextFunction } from 'express';

/**
 * Bearer token authentication middleware.
 * Checks Authorization header or ?token= query param against DASHBOARD_TOKEN env var.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.DASHBOARD_TOKEN;

  if (!token) {
    res.status(500).json({ error: 'DASHBOARD_TOKEN not configured' });
    return;
  }

  // Check Authorization: Bearer <token> header
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer' && parts[1] === token) {
      next();
      return;
    }
  }

  // Check ?token= query param (for browser page loads)
  if (req.query.token === token) {
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized. Provide a valid Bearer token or ?token= param.' });
}
