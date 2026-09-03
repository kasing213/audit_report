/**
 * Strict workspace resolution for agent requests.
 *
 * resolveOrg() coerces anything it does not recognise to Company. That is the
 * right behaviour for a browser — a stale cookie should not break the
 * dashboard — but it is the wrong behaviour for a worker: a Payment worker with
 * a typo in ORG_ID would silently start claiming and sending Company
 * proposals to the wrong customers from the wrong Telegram account.
 *
 * So agent routes go through this instead. A missing, unregistered, malformed,
 * or duplicated X-Org-Id is a 400, never a fallback.
 */
import { NextFunction, Request, Response } from 'express';
import { ORG_HEADER_NAME, strictWorkerOrg } from './org-context';

export function requireWorkerOrg(req: Request, res: Response, next: NextFunction): void {
  // Express yields an array when a header is sent more than once; strictWorkerOrg
  // rejects that rather than picking one.
  const org = strictWorkerOrg(req.headers[ORG_HEADER_NAME]);
  if (!org) {
    res.status(400).json({ error: 'X-Org-Id header must name a registered workspace' });
    return;
  }
  res.locals.workerOrg = org;
  next();
}

/** The workspace a validated agent request declared. */
export function workerOrg(res: Response): string {
  const org = res.locals.workerOrg;
  if (typeof org !== 'string' || org.length === 0) {
    throw new Error('requireWorkerOrg must run before workerOrg');
  }
  return org;
}
