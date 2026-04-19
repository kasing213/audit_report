import express, { Request, Response } from 'express';
import { authMiddleware, getSessionUser } from './auth-middleware';
import { OutreachRepository } from '../outreach/outreach-repository';
import { generateBatch } from '../outreach/outreach-agent';
import { SalesCaseRepository } from '../database/repository';
import { LeadEventDocument } from '../database/models';
import { Logger } from '../utils/logger';

const router = express.Router();
const LEASE_MS = 5 * 60 * 1000; // 5 min

router.use(authMiddleware);

// POST /crm/api/outreach/generate
router.post('/generate', express.json(), async (req: Request, res: Response) => {
  try {
    const { limit, followerFilter, phones, staleDays } = req.body || {};
    const opts: Parameters<typeof generateBatch>[0] = {};
    if (typeof limit === 'number') opts.limit = limit;
    if (typeof followerFilter === 'string') opts.followerFilter = followerFilter;
    if (Array.isArray(phones)) opts.phones = phones.filter((p): p is string => typeof p === 'string');
    if (typeof staleDays === 'number') opts.staleDays = staleDays;
    const result = await generateBatch(opts);
    res.json(result);
  } catch (err) {
    Logger.error('outreach/generate failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /crm/api/outreach?status=pending&limit=100
router.get('/', async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || 'pending';
    const limit = Math.min(parseInt((req.query.limit as string) || '100', 10) || 100, 500);
    const repo = new OutreachRepository();
    const proposals = await repo.listByStatus(status as any, limit);
    const counts = await repo.counts();
    res.json({ proposals, counts });
  } catch (err) {
    Logger.error('outreach list failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/:id/approve
router.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const approver = getSessionUser(req) || 'unknown';
    const ok = await new OutreachRepository().approve(req.params.id, approver);
    if (!ok) { res.status(404).json({ error: 'Not pending or not found' }); return; }
    res.json({ success: true });
  } catch (err) {
    Logger.error('outreach approve failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/:id/skip
router.post('/:id/skip', express.json(), async (req: Request, res: Response) => {
  try {
    const reason = (req.body?.reason as string) || 'skipped by operator';
    const ok = await new OutreachRepository().skip(req.params.id, reason);
    if (!ok) { res.status(404).json({ error: 'Not pending/approved or not found' }); return; }
    res.json({ success: true });
  } catch (err) {
    Logger.error('outreach skip failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /crm/api/outreach/:id
router.patch('/:id', express.json(), async (req: Request, res: Response) => {
  try {
    const message = req.body?.message;
    if (typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'message required' });
      return;
    }
    const ok = await new OutreachRepository().updateMessage(req.params.id, message.trim());
    if (!ok) { res.status(404).json({ error: 'Not pending or not found' }); return; }
    res.json({ success: true });
  } catch (err) {
    Logger.error('outreach patch failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/claim  (worker)
router.post('/claim', async (_req: Request, res: Response) => {
  try {
    const repo = new OutreachRepository();
    const proposal = await repo.claimNextApproved(LEASE_MS);
    if (!proposal) { res.json({ proposal: null }); return; }
    res.json({ proposal });
  } catch (err) {
    Logger.error('outreach claim failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/:id/mark-sent  (worker)
router.post('/:id/mark-sent', async (req: Request, res: Response) => {
  try {
    const outreachRepo = new OutreachRepository();
    const proposal = await outreachRepo.getById(req.params.id);
    if (!proposal) { res.status(404).json({ error: 'not found' }); return; }
    if (proposal.status !== 'in_flight') {
      res.status(409).json({ error: `status is ${proposal.status}, expected in_flight` });
      return;
    }

    const ok = await outreachRepo.markSent(req.params.id);
    if (!ok) { res.status(409).json({ error: 'could not mark sent' }); return; }

    // Record a lead event for the outbound message.
    const salesRepo = new SalesCaseRepository();
    const today = new Date().toISOString().slice(0, 10);
    const leadEvent: LeadEventDocument = {
      date: today,
      customer: { name: proposal.customer_name, phone: proposal.customer_phone },
      page: null,
      follower: proposal.follower,
      status_text: 'outreach sent (AI-drafted, worker-delivered)',
      reason_code: proposal.reason_code,
      note: proposal.message,
      group_id: null,
      source: { telegram_msg_id: `outreach-${proposal._id}`, model: 'outreach-worker' },
      created_at: new Date(),
    };
    await salesRepo.saveLeadEvent(leadEvent);

    await salesRepo.logAudit({
      timestamp: new Date(),
      action: 'outreach-sent',
      message_id: 0,
      user_id: 0,
      username: 'outreach-worker',
      original_message: proposal.message,
      parsed_result: { proposal_id: String(proposal._id), phone: proposal.customer_phone, approved_by: proposal.approved_by },
    });

    res.json({ success: true });
  } catch (err) {
    Logger.error('outreach mark-sent failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/:id/mark-failed  (worker)
router.post('/:id/mark-failed', express.json(), async (req: Request, res: Response) => {
  try {
    const reason = (req.body?.reason as string) || 'unspecified worker failure';
    const ok = await new OutreachRepository().markFailed(req.params.id, reason);
    if (!ok) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ success: true });
  } catch (err) {
    Logger.error('outreach mark-failed failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
