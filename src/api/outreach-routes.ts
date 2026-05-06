import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { authMiddleware, getSessionUser } from './auth-middleware';
import { OutreachRepository } from '../outreach/outreach-repository';
import { OutreachImagesRepository } from '../outreach/outreach-images-repository';
import { OutreachWorkerStateRepository } from '../outreach/outreach-worker-state-repository';
import { generateBatch } from '../outreach/outreach-agent';
import { getRegisteredOutreachScheduler } from '../scheduler/outreach-scheduler';
import { SalesCaseRepository } from '../database/repository';
import { LeadEventDocument } from '../database/models';
import { Logger } from '../utils/logger';
import { notifyOutreachFailure, AlertKind } from '../outreach/outreach-alerts';
import { notifyInboundReply } from '../outreach/inbound-alerts';
import { InboundMessagesRepository } from '../database/inbound-messages-repository';
import { ObjectId } from 'mongodb';

const router = express.Router();
const LEASE_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_DAILY_CAP = 15;
const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } });

function dailyCap(): number {
  const parsed = Number(process.env.DAILY_CAP);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_CAP;
}

router.use(authMiddleware);

function agentOnly(req: Request, res: Response, next: NextFunction): void {
  if (getSessionUser(req) !== 'agent') {
    res.status(403).json({ error: 'agent role required' });
    return;
  }
  next();
}

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

// GET /crm/api/outreach/worker-status — visible to any logged-in user (UI badge polls this)
router.get('/worker-status', async (_req: Request, res: Response) => {
  try {
    const state = await new OutreachWorkerStateRepository().getStatus();
    res.json({
      paused: state.paused,
      last_heartbeat_at: state.last_heartbeat_at,
      worker_id: state.worker_id,
      sent_today: state.sent_today,
      claims_today: state.claims_today,
      claims_today_day: state.claims_today_day,
      last_error: state.last_error,
      daily_cap: dailyCap(),
    });
  } catch (err) {
    Logger.error('outreach worker-status failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/scheduler/run-once — fire the daily scan synchronously
// for testing. Same code path the cron tick uses (rolls the draft-budget counter
// and posts the audit-chat summary), so it exercises the end-to-end flow without
// waiting for 9 AM.
router.post('/scheduler/run-once', async (_req: Request, res: Response) => {
  const sched = getRegisteredOutreachScheduler();
  if (!sched) {
    res.status(503).json({ error: 'scheduler not registered yet' });
    return;
  }
  try {
    await sched.triggerNow();
    res.json({ ok: true });
  } catch (err) {
    Logger.error('outreach scheduler run-once failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/pause — toggle or set pause state
router.post('/pause', express.json(), async (req: Request, res: Response) => {
  try {
    const repo = new OutreachWorkerStateRepository();
    const current = await repo.getStatus();
    const target = typeof req.body?.paused === 'boolean' ? req.body.paused : !current.paused;
    await repo.setPaused(target);
    res.json({ paused: target });
  } catch (err) {
    Logger.error('outreach pause failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/worker-heartbeat — agent only
router.post('/worker-heartbeat', express.json(), agentOnly, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const workerId = typeof body.worker_id === 'string' ? body.worker_id : 'unknown';
    const sentToday = Number.isFinite(body.sent_today) ? Number(body.sent_today) : 0;
    const lastError = typeof body.last_error === 'string' ? body.last_error : null;
    const repo = new OutreachWorkerStateRepository();
    await repo.setHeartbeat({ worker_id: workerId, sent_today: sentToday, last_error: lastError });
    const state = await repo.getStatus();
    res.json({ ok: true, paused: state.paused, daily_cap: dailyCap() });
  } catch (err) {
    Logger.error('outreach worker-heartbeat failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/worker-alert — agent only; fires a manager alert
router.post('/worker-alert', express.json(), agentOnly, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const kind = (body.kind as AlertKind) || 'worker-fatal';
    const reason = typeof body.reason === 'string' ? body.reason : 'unspecified';
    const workerId = typeof body.worker_id === 'string' ? body.worker_id : undefined;
    await notifyOutreachFailure(null, kind, { reason, worker_id: workerId });
    if (kind === 'session-expired' || kind === 'worker-fatal') {
      await new OutreachWorkerStateRepository().setLastError(`${kind}: ${reason}`);
    }
    res.json({ ok: true });
  } catch (err) {
    Logger.error('outreach worker-alert failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/report-inbound — agent only
// Worker reports an inbound customer reply scraped from the user's Telegram inbox.
// Idempotent on (phone, telegram_message_id). Alerts the audit-trail group on
// first insert; deduped re-posts return { deduped: true } without alerting.
router.post('/report-inbound', express.json(), agentOnly, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const phoneRaw = typeof body.phone === 'string' ? body.phone : '';
    const messageIdRaw = body.telegram_message_id;
    const text = typeof body.text === 'string' ? body.text : '';
    const receivedAtRaw = typeof body.received_at === 'string' ? body.received_at : null;

    const phone = phoneRaw.replace(/\D/g, '');
    if (!phone) {
      res.status(400).json({ error: 'phone required (digits)' });
      return;
    }
    if (typeof messageIdRaw !== 'number' || !Number.isFinite(messageIdRaw)) {
      res.status(400).json({ error: 'telegram_message_id required (number)' });
      return;
    }
    if (!text) {
      res.status(400).json({ error: 'text required' });
      return;
    }

    const receivedAt = receivedAtRaw ? new Date(receivedAtRaw) : new Date();
    if (Number.isNaN(receivedAt.getTime())) {
      res.status(400).json({ error: 'received_at invalid' });
      return;
    }

    const customer = await new SalesCaseRepository().findLatestEventByPhone(phone);
    const customerId = customer?._id ? new ObjectId(String(customer._id)) : null;
    const customerName = customer?.customer?.name ?? null;
    const follower = customer?.follower ?? null;

    const repo = new InboundMessagesRepository();
    const { inserted, doc } = await repo.upsertInboundMessage({
      phone,
      telegram_message_id: messageIdRaw,
      text,
      received_at: receivedAt,
      customer_id: customerId,
      customer_name: customerName,
      follower,
    });

    if (!inserted) {
      res.json({ ok: true, deduped: true });
      return;
    }

    const chatId = process.env.AUDIT_CHAT_ID || process.env.SUMMARY_CHAT_ID;
    if (!chatId) {
      Logger.warn('report-inbound: AUDIT_CHAT_ID and SUMMARY_CHAT_ID both unset, dropping alert');
      res.json({ ok: true, alert: 'dropped-no-chat' });
      return;
    }

    const sent = await notifyInboundReply(chatId, {
      name: customerName,
      phone,
      text,
      follower,
    });
    if (sent && doc._id) {
      await repo.markNotified(doc._id, chatId);
    }
    res.json({ ok: true, alert: sent ? 'sent' : 'failed' });
  } catch (err) {
    Logger.error('outreach report-inbound failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /crm/api/outreach/default-image  — returns binary
router.get('/default-image', async (_req: Request, res: Response) => {
  try {
    const repo = new OutreachImagesRepository();
    const doc = await repo.getDefault();
    if (!doc) {
      res.status(404).json({ error: 'No default image set' });
      return;
    }
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('X-Filename', encodeURIComponent(doc.filename));
    res.setHeader('Content-Length', String(doc.size_bytes));
    res.send(doc.data.buffer);
  } catch (err) {
    Logger.error('default-image GET failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/default-image  — multipart upload, replaces default
router.post('/default-image', imageUpload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded (field name: file)' }); return; }
    if (!ALLOWED_IMAGE_MIME.includes(req.file.mimetype)) {
      res.status(400).json({ error: `Mime ${req.file.mimetype} not allowed; use JPEG, PNG, or WebP` });
      return;
    }
    const uploadedBy = getSessionUser(req) || 'unknown';
    await new OutreachImagesRepository().setDefault({
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      buffer: req.file.buffer,
      uploaded_by: uploadedBy,
    });
    Logger.info(`outreach default image replaced by ${uploadedBy}: ${req.file.originalname} (${req.file.size}B, ${req.file.mimetype})`);
    res.json({ ok: true, filename: req.file.originalname, size_bytes: req.file.size, mime_type: req.file.mimetype });
  } catch (err) {
    Logger.error('default-image POST failed', err as Error);
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

// DELETE /crm/api/outreach/all — nuke all proposals (admin cleanup)
router.delete('/all', async (_req: Request, res: Response) => {
  try {
    const deleted = await new OutreachRepository().deleteAll();
    res.json({ deleted });
  } catch (err) {
    Logger.error('outreach deleteAll failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/claim  (worker)
router.post('/claim', async (_req: Request, res: Response) => {
  try {
    const stateRepo = new OutreachWorkerStateRepository();
    const state = await stateRepo.getStatus();
    if (state.paused) {
      res.json({ proposal: null, paused: true });
      return;
    }

    const reserved = await stateRepo.tryReserveClaim(dailyCap());
    if (reserved === null) {
      res.json({ proposal: null, daily_cap_reached: true });
      return;
    }

    const repo = new OutreachRepository();
    const proposal = await repo.claimNextApproved(LEASE_MS, async (expired) => {
      // Capped re-leases that finally flip to failed call this hook.
      try {
        await notifyOutreachFailure(expired, 'lease-expired', { reason: 'lease expired without resolution (3rd attempt)' });
      } catch (err) {
        Logger.error('lease-expired alert failed', err as Error);
      }
    });

    if (!proposal) {
      // Nothing to send — release the reservation so the cap reflects real sends only.
      await stateRepo.releaseClaim();
      res.json({ proposal: null });
      return;
    }
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
    const outreachRepo = new OutreachRepository();
    const proposal = await outreachRepo.getById(req.params.id);
    if (!proposal) { res.status(404).json({ error: 'not found' }); return; }
    const ok = await outreachRepo.markFailed(req.params.id, reason);
    if (!ok) { res.status(404).json({ error: 'not found' }); return; }
    // Free the daily reservation since this attempt didn't actually send.
    try { await new OutreachWorkerStateRepository().releaseClaim(); } catch (e) { Logger.warn(`releaseClaim on mark-failed: ${(e as Error).message}`); }
    notifyOutreachFailure(proposal, 'mark-failed', { reason }).catch((err) => {
      Logger.error('mark-failed alert dispatch errored', err as Error);
    });
    res.json({ success: true });
  } catch (err) {
    Logger.error('outreach mark-failed failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
