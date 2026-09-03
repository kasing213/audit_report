/**
 * Dashboard endpoints for the Payment Tracker workspace.
 *
 * Mounted under /crm/api/outreach/payment. Every route here is a dashboard
 * action, never a worker one — the agent path allowlist in auth-middleware does
 * not include this prefix, so a worker token gets 403 regardless of what it
 * asks for. That separation is deliberate: wording, approval, and Auto mode are
 * human decisions.
 */
import express, { Request, Response } from 'express';
import { Logger } from '../utils/logger';
import { getSessionUser } from './auth-middleware';
import { defaultProposalCollectionPort } from '../outreach/outreach-repository';
import { OutreachWorkerStateRepository } from '../outreach/outreach-worker-state-repository';
import { PaymentTemplateRepository } from '../payment-tracker/payment-template-repository';
import { PaymentTemplateError } from '../payment-tracker/payment-template';
import { PaymentScanStateRepository } from '../payment-tracker/payment-scan-state-repository';
import {
  PaymentActivationError,
  PaymentSettingsService,
} from '../payment-tracker/payment-settings-service';
import { getRegisteredPaymentTrackerScheduler } from '../scheduler/payment-tracker-scheduler';

const router = express.Router();

function service(): PaymentSettingsService {
  const stateRepo = new OutreachWorkerStateRepository();
  return new PaymentSettingsService({
    templates: new PaymentTemplateRepository(),
    workerState: {
      getAutoApprove: (orgId) => stateRepo.getAutoApprove(orgId),
      setAutoApprove: (orgId, enabled) => stateRepo.setAutoApprove(orgId, enabled),
    },
    proposals: defaultProposalCollectionPort(),
    scanState: new PaymentScanStateRepository(),
  });
}

/** Dashboard users only. A worker has no business editing customer wording. */
function dashboardOnly(req: Request, res: Response): string | null {
  const role = getSessionUser(req);
  if (role !== 'developer' && role !== 'manager') {
    res.status(403).json({ error: 'dashboard role required' });
    return null;
  }
  return role;
}

function handleError(err: unknown, res: Response, context: string): void {
  if (err instanceof PaymentActivationError) {
    res.status(409).json({ error: (err as Error).message });
    return;
  }
  if (err instanceof PaymentTemplateError) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  Logger.error(context, err as Error);
  res.status(500).json({ error: (err as Error).message });
}

// GET /crm/api/outreach/payment/template
router.get('/template', async (_req: Request, res: Response) => {
  try {
    res.json({ template: await new PaymentTemplateRepository().get() });
  } catch (err) {
    handleError(err, res, 'payment template read failed');
  }
});

// PUT /crm/api/outreach/payment/template — saving always revokes approval
router.put('/template', express.json(), async (req: Request, res: Response) => {
  const actor = dashboardOnly(req, res);
  if (!actor) return;
  try {
    const text = req.body?.text;
    if (typeof text !== 'string') {
      res.status(400).json({ error: 'text required' });
      return;
    }
    res.json({ template: await service().saveTemplate(text, actor) });
  } catch (err) {
    handleError(err, res, 'payment template save failed');
  }
});

// POST /crm/api/outreach/payment/template/approve
router.post('/template/approve', async (req: Request, res: Response) => {
  const actor = dashboardOnly(req, res);
  if (!actor) return;
  try {
    res.json({ template: await service().approveTemplate(actor) });
  } catch (err) {
    handleError(err, res, 'payment template approve failed');
  }
});

// GET /crm/api/outreach/payment/source-status — redacted metadata only
router.get('/source-status', async (_req: Request, res: Response) => {
  try {
    res.json(await service().getSourceStatus());
  } catch (err) {
    handleError(err, res, 'payment source status failed');
  }
});

// POST /crm/api/outreach/payment/scan-now
router.post('/scan-now', async (req: Request, res: Response) => {
  const actor = dashboardOnly(req, res);
  if (!actor) return;
  try {
    const scheduler = getRegisteredPaymentTrackerScheduler();
    if (!scheduler) {
      res.status(409).json({ error: 'payment tracker scheduler is not running' });
      return;
    }
    // triggerNow refuses for the same reasons the cron run would — missing
    // credential, unapproved wording — so this cannot bypass those gates.
    res.json({ result: await scheduler.triggerNow() });
  } catch (err) {
    handleError(err, res, 'payment scan-now failed');
  }
});

export default router;
