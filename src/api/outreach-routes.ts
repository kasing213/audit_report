import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { authMiddleware, getSessionUser } from './auth-middleware';
import { OutreachRepository } from '../outreach/outreach-repository';
import { OutreachImagesRepository, OutreachImageDocument } from '../outreach/outreach-images-repository';
import { OutreachVideoRepository, VideoBudgetExceededError, MAX_VIDEO_COUNT, MAX_TOTAL_VIDEO_BYTES } from '../outreach/outreach-video-repository';
import { OutreachSettingsRepository } from '../outreach/outreach-settings-repository';
import { getStaticOutreachMessage, DEFAULT_STATIC_MESSAGE } from '../outreach/static-template';
import { R2StorageService } from '../outreach/r2-storage-service';
import { OutreachWorkerStateRepository } from '../outreach/outreach-worker-state-repository';
import { resolveOrg } from '../outreach/org-context';
import { normalizeOrg } from '../outreach/orgs';
import { OutreachSuppressionRepository, SuppressionKind, SuppressionStatus, SuppressionListQuery } from '../outreach/outreach-suppression-repository';
import { generateBatch } from '../outreach/outreach-agent';
import { formatPhoneDisplay, formatTelegramLink } from '../utils/phone-utils';
import { getTodayDate, getZonedDayRangeUtc } from '../utils/time';
import { currentMinutesInTz, isWithinHourRange } from '../utils/cron-time';
import { getRegisteredOutreachScheduler } from '../scheduler/outreach-scheduler';
import { getRegisteredHeartbeatWatchdogScheduler } from '../scheduler/heartbeat-watchdog-scheduler';
import { OutreachScheduleSettingsRepository } from '../outreach/outreach-schedule-settings-repository';
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
const DEFAULT_AUTO_APPROVE_WINDOW = 5;
const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES } });

const ALLOWED_VIDEO_MIME = ['video/mp4'];
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB
const videoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_VIDEO_BYTES } });

function autoApproveWindow(): number {
  const parsed = Number(process.env.OUTREACH_AUTO_APPROVE_WINDOW);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_AUTO_APPROVE_WINDOW;
}

function imageUploadErrorHandler(err: any, _req: Request, res: Response, next: NextFunction): void {
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.name === 'MulterError' && err.code === 'LIMIT_FILE_SIZE')) {
    res.status(413).json({ error: `File exceeds ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB limit` });
    return;
  }
  if (err) {
    Logger.error('image upload middleware error', err);
    res.status(400).json({ error: err.message || 'upload error' });
    return;
  }
  next();
}

function videoUploadErrorHandler(err: any, _req: Request, res: Response, next: NextFunction): void {
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.name === 'MulterError' && err.code === 'LIMIT_FILE_SIZE')) {
    res.status(413).json({ error: `File exceeds ${Math.round(MAX_VIDEO_BYTES / 1024 / 1024)} MB limit` });
    return;
  }
  if (err) {
    Logger.error('video upload middleware error', err);
    res.status(400).json({ error: err.message || 'upload error' });
    return;
  }
  next();
}

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
    const org = resolveOrg(req);
    // Image, video and a custom message are all optional — the worker sends
    // text-only (built-in template) when an org has no default image/video set.
    const { limit, followerFilter, phones, staleDays } = req.body || {};
    const opts: Parameters<typeof generateBatch>[0] = { orgId: org };
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
    const org = resolveOrg(req);
    const status = (req.query.status as string) || 'pending';
    const limit = Math.min(parseInt((req.query.limit as string) || '100', 10) || 100, 500);
    const repo = new OutreachRepository();
    const proposals = await repo.listByStatus(org, status as any, limit);
    const counts = await repo.counts(org);
    res.json({ org, proposals, counts });
  } catch (err) {
    Logger.error('outreach list failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /crm/api/outreach/worker-status — visible to any logged-in user (UI badge polls this)
router.get('/worker-status', async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const state = await new OutreachWorkerStateRepository().getStatus(org);
    res.json({
      org,
      paused: state.paused,
      auto_approve: state.auto_approve,
      last_heartbeat_at: state.last_heartbeat_at,
      worker_id: state.worker_id,
      sent_today: state.sent_today,
      claims_today: state.claims_today,
      deliveries_today: state.deliveries_today,
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
// for testing. Same code path the cron tick uses (per-org top-up against each
// workspace's queue target and auto-approve setting, then posts the audit-chat
// summary), so it exercises the end-to-end flow without waiting for 9 AM.
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

// POST /crm/api/outreach/scheduler/topup-once — fire the mid-day top-up check
// synchronously for testing. Same code path the half-hourly cron tick uses.
router.post('/scheduler/topup-once', async (_req: Request, res: Response) => {
  const sched = getRegisteredOutreachScheduler();
  if (!sched) {
    res.status(503).json({ error: 'scheduler not registered yet' });
    return;
  }
  try {
    await sched.triggerTopUpNow();
    res.json({ ok: true });
  } catch (err) {
    Logger.error('outreach scheduler topup-once failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /crm/api/outreach/schedule-settings — the dashboard-editable schedule
// times (scan/bounce/active-hours). Agent-readable too: the Mac worker polls
// bounce_time here to self-restart at the configured time instead of relying
// on a local pm2 cron_restart it has no way to update.
router.get('/schedule-settings', async (_req: Request, res: Response) => {
  try {
    const settings = await new OutreachScheduleSettingsRepository().getEffective();
    res.json(settings);
  } catch (err) {
    Logger.error('outreach schedule-settings get failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/schedule-settings — update one or more schedule
// times and immediately reschedule the live cron jobs (no redeploy). Global,
// not per-org: the scan/top-up/watchdog crons already loop over every org on
// one shared tick, and the Mac serves both org workers.
router.post('/schedule-settings', express.json(), async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const update: Record<string, unknown> = {};
    if (body.scan_time !== undefined) update.scan_time = body.scan_time;
    if (body.bounce_time !== undefined) update.bounce_time = body.bounce_time;
    if (body.active_start_hour !== undefined) update.active_start_hour = Number(body.active_start_hour);
    if (body.active_end_hour !== undefined) update.active_end_hour = Number(body.active_end_hour);

    const approver = getSessionUser(req) || 'schedule-settings';
    const settings = await new OutreachScheduleSettingsRepository().set(update, approver);

    getRegisteredOutreachScheduler()?.applySchedule(settings);
    getRegisteredHeartbeatWatchdogScheduler()?.applySchedule(settings.active_start_hour, settings.active_end_hour);

    Logger.info(`[outreach] schedule-settings updated by=${approver}: ${JSON.stringify(settings)}`);
    res.json({ ok: true, settings });
  } catch (err) {
    Logger.error('outreach schedule-settings post failed', err as Error);
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/pause — toggle or set pause state
router.post('/pause', express.json(), async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const repo = new OutreachWorkerStateRepository();
    const current = await repo.getStatus(org);
    const target = typeof req.body?.paused === 'boolean' ? req.body.paused : !current.paused;
    await repo.setPaused(org, target);
    res.json({ org, paused: target });
  } catch (err) {
    Logger.error('outreach pause failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/auto-approve — toggle or set this workspace's approval mode.
// Isolated per org: flipping company does not touch personal.
router.post('/auto-approve', express.json(), async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const repo = new OutreachWorkerStateRepository();
    const current = await repo.getStatus(org);
    const target = typeof req.body?.enabled === 'boolean' ? req.body.enabled : !current.auto_approve;
    await repo.setAutoApprove(org, target);

    let approvedCount = 0;
    if (target) {
      // Release one small window; leave the rest pending until it settles.
      const approver = getSessionUser(req) || 'auto-approve';
      approvedCount = await new OutreachRepository().approveNextPendingWindow(org, approver, autoApproveWindow());
    }

    Logger.info(`[outreach] auto_approve org=${org} -> ${target}${approvedCount ? ` (${approvedCount} pending approved)` : ''}`);
    res.json({ org, auto_approve: target, approved_count: approvedCount });
  } catch (err) {
    Logger.error('outreach auto-approve toggle failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/worker-heartbeat — agent only
router.post('/worker-heartbeat', express.json(), agentOnly, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const org = resolveOrg(req);
    const workerId = typeof body.worker_id === 'string' ? body.worker_id : 'unknown';
    const sentToday = Number.isFinite(body.sent_today) ? Number(body.sent_today) : 0;
    const lastError = typeof body.last_error === 'string' ? body.last_error : null;
    const repo = new OutreachWorkerStateRepository();
    await repo.setHeartbeat(org, { worker_id: workerId, sent_today: sentToday, last_error: lastError });
    const state = await repo.getStatus(org);
    res.json({ ok: true, org, paused: state.paused, daily_cap: dailyCap() });
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
    const org = resolveOrg(req);

    if (kind === 'daily-cap-reached') {
      // Personal DM only — never the boss/dev audit group. Unlike the other
      // worker-level kinds (which fall back to AUDIT_CHAT_ID on purpose so a
      // real failure is never silently dropped), a routine cap-reached ping
      // with nowhere configured to go should just be dropped.
      const dmChatId = process.env.WORKER_ALERT_CHAT_ID;
      if (!dmChatId) {
        Logger.warn('outreach worker-alert: WORKER_ALERT_CHAT_ID not set, dropping daily-cap-reached alert');
        res.json({ ok: true });
        return;
      }
      await notifyOutreachFailure(null, kind, { reason, worker_id: workerId, org, chatId: dmChatId });
      res.json({ ok: true });
      return;
    }

    await notifyOutreachFailure(null, kind, { reason, worker_id: workerId, org });
    if (kind === 'session-expired' || kind === 'worker-fatal') {
      await new OutreachWorkerStateRepository().setLastError(org, `${kind}: ${reason}`);
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

    const org = resolveOrg(req);
    const customer = await new SalesCaseRepository().findLatestEventByPhone(phone, org);
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
router.get('/default-image', async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const repo = new OutreachImagesRepository();
    const doc = await repo.getDefault(org);
    if (!doc) {
      res.status(404).json({ error: `No default image set for the ${org} workspace` });
      return;
    }
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('X-Filename', encodeURIComponent(doc.filename));
    res.setHeader('Content-Length', String(doc.size_bytes));
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(doc.data.buffer);
  } catch (err) {
    Logger.error('default-image GET failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/default-image  — multipart upload, replaces default
router.post('/default-image', imageUpload.single('file'), imageUploadErrorHandler, async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded (field name: file)' }); return; }
    if (!ALLOWED_IMAGE_MIME.includes(req.file.mimetype)) {
      res.status(400).json({ error: `Mime ${req.file.mimetype} not allowed; use JPEG, PNG, or WebP` });
      return;
    }
    const org = resolveOrg(req);
    const uploadedBy = getSessionUser(req) || 'unknown';
    await new OutreachImagesRepository().setDefault({
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      buffer: req.file.buffer,
      uploaded_by: uploadedBy,
    }, org);
    Logger.info(`outreach default image replaced by ${uploadedBy} for org=${org}: ${req.file.originalname} (${req.file.size}B, ${req.file.mimetype})`);
    res.json({ ok: true, filename: req.file.originalname, size_bytes: req.file.size, mime_type: req.file.mimetype });
  } catch (err) {
    Logger.error('default-image POST failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /crm/api/outreach/default-image — clear this workspace's default image.
// Bytes live in Mongo (no R2), so deleting the doc fully removes it. Outreach for
// this org stays disabled (the UI gates Generate) until a new image is uploaded.
router.delete('/default-image', async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const removed = await new OutreachImagesRepository().clearDefault(org);
    Logger.info(`outreach default image removed by ${getSessionUser(req) || 'unknown'} for org=${org} (removed=${removed})`);
    res.json({ ok: true, removed });
  } catch (err) {
    Logger.error('default-image DELETE failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /crm/api/outreach/default-video — the CRM UI's queued-video list + budget
router.get('/default-video', async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const videos = await new OutreachVideoRepository().listAll(org);
    const total_bytes = videos.reduce((sum, v) => sum + (v.size_bytes || 0), 0);
    res.json({
      videos: videos.map((v) => ({
        id: v._id!.toString(),
        filename: v.filename,
        mime_type: v.mime_type,
        size_bytes: v.size_bytes,
        uploaded_at: v.uploaded_at,
        uploaded_by: v.uploaded_by,
      })),
      total_bytes,
      max_bytes: MAX_TOTAL_VIDEO_BYTES,
      max_count: MAX_VIDEO_COUNT,
    });
  } catch (err) {
    Logger.error('default-video GET failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/default-video — multipart upload, ADDS a video to the
// org's queue (rejected with 400 before any R2 upload if it would breach the
// count or combined-size budget).
router.post('/default-video', videoUpload.single('file'), videoUploadErrorHandler, async (req: Request, res: Response) => {
  try {
    const r2 = new R2StorageService();
    if (!r2.isConfigured()) {
      res.status(503).json({ error: 'R2 storage not configured (set R2_ACCOUNT_ID / R2_ACCESS_KEY / R2_SECRET_KEY / R2_BUCKET)' });
      return;
    }
    if (!req.file) { res.status(400).json({ error: 'No file uploaded (field name: file)' }); return; }
    if (!ALLOWED_VIDEO_MIME.includes(req.file.mimetype)) {
      res.status(400).json({ error: `Mime ${req.file.mimetype} not allowed; use MP4 (video/mp4)` });
      return;
    }

    const org = resolveOrg(req);
    const uploadedBy = getSessionUser(req) || 'unknown';
    const repo = new OutreachVideoRepository();

    // Cheap pre-check against the existing queue before spending an R2 upload.
    const existing = await repo.listAll(org);
    const currentBytes = existing.reduce((sum, v) => sum + (v.size_bytes || 0), 0);
    if (existing.length >= MAX_VIDEO_COUNT) {
      res.status(400).json({ error: `Already at the ${MAX_VIDEO_COUNT}-video limit` });
      return;
    }
    if (currentBytes + req.file.size > MAX_TOTAL_VIDEO_BYTES) {
      res.status(400).json({
        error: `Adding this ${(req.file.size / (1024 * 1024)).toFixed(1)}MB video would exceed the ` +
          `${(MAX_TOTAL_VIDEO_BYTES / (1024 * 1024)).toFixed(0)}MB total (already using ${(currentBytes / (1024 * 1024)).toFixed(1)}MB)`,
      });
      return;
    }

    const key = await r2.uploadVideo(req.file.buffer, req.file.mimetype);
    let doc;
    try {
      doc = await repo.add({
        r2_key: key,
        filename: req.file.originalname,
        mime_type: req.file.mimetype,
        size_bytes: req.file.size,
        uploaded_by: uploadedBy,
      }, org);
    } catch (err) {
      if (err instanceof VideoBudgetExceededError) {
        // Lost a race against a concurrent upload — the bytes are already in
        // R2 with nothing pointing at them; clean up before returning 400.
        await r2.deleteObject(key).catch(() => {});
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    Logger.info(`outreach video added by ${uploadedBy} for org=${org}: ${req.file.originalname} (${req.file.size}B) key=${key}`);
    res.json({ ok: true, id: doc._id!.toString(), filename: req.file.originalname, size_bytes: req.file.size, mime_type: req.file.mimetype });
  } catch (err) {
    Logger.error('default-video POST failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /crm/api/outreach/default-video/:id — remove one queued video, delete its R2 object
router.delete('/default-video/:id', async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const removedKey = await new OutreachVideoRepository().remove(org, req.params.id);
    if (removedKey) {
      await new R2StorageService().deleteObject(removedKey).catch(() => {});
    }
    res.json({ ok: true, removed: Boolean(removedKey) });
  } catch (err) {
    Logger.error('default-video DELETE failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /crm/api/outreach/default-text — effective message + whether a custom one is saved
router.get('/default-text', async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const repo = new OutreachSettingsRepository();
    const saved = await repo.getStaticMessage(org);
    let updated_at: Date | null = null;
    let updated_by: string | null = null;
    if (saved && saved.trim()) {
      const doc = await repo.getDefaultDoc(org);
      updated_at = doc?.updated_at ?? null;
      updated_by = doc?.updated_by ?? null;
    }
    const message = await getStaticOutreachMessage(org);
    res.json({
      org,
      message,
      is_custom: Boolean(saved && saved.trim()),
      updated_at,
      updated_by,
      default_message: DEFAULT_STATIC_MESSAGE,
    });
  } catch (err) {
    Logger.error('default-text GET failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/default-text — save the operator-edited default message
router.post('/default-text', express.json(), async (req: Request, res: Response) => {
  try {
    const raw = req.body?.message;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      res.status(400).json({ error: 'message required' });
      return;
    }
    const message = raw.trim();
    if (message.length > 4096) {
      res.status(400).json({ error: 'message exceeds 4096 characters' });
      return;
    }
    const org = resolveOrg(req);
    const updatedBy = getSessionUser(req) || 'unknown';
    await new OutreachSettingsRepository().setStaticMessage(message, updatedBy, org);
    Logger.info(`outreach default text updated by ${updatedBy} for org=${org} (${message.length} chars)`);
    res.json({ ok: true });
  } catch (err) {
    Logger.error('default-text POST failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /crm/api/outreach/default-text — clear the saved message, revert to env/hardcoded
router.delete('/default-text', async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    await new OutreachSettingsRepository().clearStaticMessage(org);
    Logger.info(`outreach default text reset to default by ${getSessionUser(req) || 'unknown'} for org=${org}`);
    res.json({ ok: true });
  } catch (err) {
    Logger.error('default-text DELETE failed', err as Error);
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

// POST /crm/api/outreach/:id/image  — multipart upload; sets custom_image_id
router.post('/:id/image', imageUpload.single('file'), imageUploadErrorHandler, async (req: Request, res: Response) => {
  const imagesRepo = new OutreachImagesRepository();
  let newId: ObjectId | undefined;
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded (field name: file)' }); return; }
    if (!ALLOWED_IMAGE_MIME.includes(req.file.mimetype)) {
      res.status(400).json({ error: `Mime ${req.file.mimetype} not allowed; use JPEG, PNG, or WebP` });
      return;
    }

    const proposalRepo = new OutreachRepository();
    const proposal = await proposalRepo.getById(req.params.id);
    if (!proposal) { res.status(404).json({ error: 'proposal not found' }); return; }
    if (proposal.status !== 'pending' && proposal.status !== 'approved') {
      res.status(409).json({ error: `cannot edit image when status is ${proposal.status}` });
      return;
    }

    const uploadedBy = getSessionUser(req) || 'unknown';

    // Insert the new custom image first, then attach it. If a previous custom
    // existed, delete it after the swap to avoid orphaning the in-use image.
    newId = await imagesRepo.insertCustom({
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      buffer: req.file.buffer,
      uploaded_by: uploadedBy,
    });
    const previousId = proposal.custom_image_id;
    const setOk = await proposalRepo.setCustomImage(req.params.id, newId);
    if (!setOk) {
      // race: status flipped between getById and setCustomImage; clean up
      await imagesRepo.deleteCustom(newId);
      newId = undefined; // already cleaned up; don't double-delete in catch
      res.status(409).json({ error: 'proposal status changed during upload' });
      return;
    }
    if (previousId) {
      await imagesRepo.deleteCustom(previousId);
    }

    Logger.info(`outreach custom image set on proposal=${req.params.id} by ${uploadedBy}: ${req.file.originalname} (${req.file.size}B, ${req.file.mimetype})`);
    res.json({ ok: true, image_id: newId.toString(), filename: req.file.originalname, size_bytes: req.file.size, mime_type: req.file.mimetype });
  } catch (err) {
    // If we inserted an image but failed to attach it, clean it up to avoid an orphan.
    if (newId) {
      await imagesRepo.deleteCustom(newId).catch(() => {});
    }
    Logger.error('proposal image POST failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /crm/api/outreach/:id/image  — removes custom, reverts to default
router.delete('/:id/image', async (req: Request, res: Response) => {
  try {
    const proposalRepo = new OutreachRepository();
    const proposal = await proposalRepo.getById(req.params.id);
    if (!proposal) { res.status(404).json({ error: 'proposal not found' }); return; }
    if (proposal.status !== 'pending' && proposal.status !== 'approved') {
      res.status(409).json({ error: `cannot edit image when status is ${proposal.status}` });
      return;
    }

    const { ok, previous } = await proposalRepo.clearCustomImage(req.params.id);
    if (!ok) { res.status(409).json({ error: 'could not clear (status changed)' }); return; }
    if (previous) {
      await new OutreachImagesRepository().deleteCustom(previous);
    }

    Logger.info(`outreach custom image cleared on proposal=${req.params.id} by ${getSessionUser(req) || 'unknown'} (prev=${previous?.toString() || 'none'})`);
    res.json({ ok: true });
  } catch (err) {
    Logger.error('proposal image DELETE failed', err as Error);
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
router.post('/claim', async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const stateRepo = new OutreachWorkerStateRepository();
    const state = await stateRepo.getStatus(org);
    if (state.paused) {
      res.json({ proposal: null, paused: true });
      return;
    }

    // Real send-time gate: without this, an `approved` proposal left over
    // from a prior day (e.g. a manual re-approve, or the daily claim/delivery
    // caps resetting at UTC midnight — 07:00 Cambodia — well before any
    // configured scan/active-hours time) gets claimed and sent the instant
    // it becomes claimable again, regardless of scan_time or active hours.
    // Checked before reserving a claim slot so an outside-hours poll doesn't
    // waste a wake-up.
    const schedule = await new OutreachScheduleSettingsRepository().getEffective();
    const tz = process.env.TIMEZONE || 'Asia/Phnom_Penh';
    const nowMinutes = currentMinutesInTz(tz);
    if (!isWithinHourRange(nowMinutes, schedule.active_start_hour, schedule.active_end_hour)) {
      res.json({ proposal: null, outside_active_hours: true });
      return;
    }

    // Only gate on deliveries — no separate attempt ceiling as of 2026-08, so
    // "cap reached" means exactly what it says: dailyCap deliveries landed.
    const reserved = await stateRepo.tryReserveClaim(org, dailyCap());
    if (reserved === null) {
      res.json({ proposal: null, daily_cap_reached: true });
      return;
    }

    const repo = new OutreachRepository();
    // Release only after a delivery slot is available. This avoids exposing a
    // fresh window at the daily cap, where it would sit approved overnight.
    if (state.auto_approve) {
      await repo.approveNextPendingWindow(org, 'auto-approve', autoApproveWindow());
    }
    const proposal = await repo.claimNextApproved(org, LEASE_MS, async (expired) => {
      // Capped re-leases that finally flip to failed call this hook.
      try {
        await notifyOutreachFailure(expired, 'lease-expired', { reason: 'lease expired without resolution (3rd attempt)' });
      } catch (err) {
        Logger.error('lease-expired alert failed', err as Error);
      }
    });

    if (!proposal) {
      // Nothing to send — release the reservation so the cap reflects real sends only.
      await stateRepo.releaseClaim(org);
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

    // Count this successful delivery toward the daily delivery cap. Only sends
    // that actually land consume a delivery slot; unreachable numbers do not.
    // Attribute to the proposal's own org (authoritative), not the request.
    try {
      await new OutreachWorkerStateRepository().recordDelivery(normalizeOrg(proposal.org_id));
    } catch (e) {
      Logger.warn(`recordDelivery on mark-sent: ${(e as Error).message}`);
    }

    // Start this phone's contact cooldown for the proposal's own workspace. This
    // also overwrites any prior failure record, so a number that finally
    // delivered leaves the Failed list — the same effect the old resolve() had.
    try {
      await new OutreachSuppressionRepository().recordContacted({
        phone: proposal.customer_phone,
        orgId: normalizeOrg(proposal.org_id),
        proposalId: proposal._id ?? null,
        customerName: proposal.customer_name,
        follower: proposal.follower,
      });
    } catch (e) {
      Logger.warn(`recordContacted on mark-sent: ${(e as Error).message}`);
    }

    // Record a lead event for the outbound message.
    const salesRepo = new SalesCaseRepository();
    const today = new Date().toISOString().slice(0, 10);
    const leadEvent: LeadEventDocument = {
      date: today,
      org_id: normalizeOrg(proposal.org_id),
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

    // No auto-retry of any kind (2026-08): every failure — transient worker/
    // network blips included — is left `failed` as-is. New leads keep flowing
    // in via the normal claim queue; a failed proposal is never resurrected
    // automatically. (A human can still bring one back explicitly via
    // /reapprove-deferred-today.)
    const ok = await outreachRepo.markFailed(req.params.id, reason);
    if (!ok) { res.status(404).json({ error: 'not found' }); return; }

    // Record the failure in the phone-level suppression ledger (stops re-hammering;
    // privacy/invalid failures are permanent, no retry clock). Best-effort.
    let failureKind: string | undefined;
    try {
      const result = await new OutreachSuppressionRepository().recordFailure({
        phone: proposal.customer_phone,
        reason,
        orgId: normalizeOrg(proposal.org_id),
        proposalId: proposal._id ?? null,
        customerName: proposal.customer_name,
        follower: proposal.follower,
      });
      failureKind = result.kind;
    } catch (e) {
      Logger.warn(`recordFailure on mark-failed: ${(e as Error).message}`);
    }

    // claims_today no longer gates anything (2026-08), but it's still the only
    // record of how many real Telegram round-trips happened today (useful for
    // spotting a throttle event, e.g. N deferred out of M attempts). Refund it
    // ONLY for transient/system failures — they never reached Telegram at all,
    // so counting them would overstate real attempts. Privacy/invalid/deferred
    // consumed a genuine ImportContacts round-trip and stay counted.
    // Unknown kind → refund (preserves prior behavior).
    if (failureKind === undefined || failureKind === 'transient') {
      try { await new OutreachWorkerStateRepository().releaseClaim(normalizeOrg(proposal.org_id)); } catch (e) { Logger.warn(`releaseClaim on mark-failed: ${(e as Error).message}`); }
    }
    notifyOutreachFailure(proposal, 'mark-failed', { reason }).catch((err) => {
      Logger.error('mark-failed alert dispatch errored', err as Error);
    });
    res.json({ success: true });
  } catch (err) {
    Logger.error('outreach mark-failed failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /crm/api/outreach/:id/effective-image  — worker-only
// Returns the bytes the worker should send: custom if custom_image_id set, else default.
router.get('/:id/effective-image', async (req: Request, res: Response) => {
  try {
    const proposalRepo = new OutreachRepository();
    const proposal = await proposalRepo.getById(req.params.id);
    if (!proposal) { res.status(404).json({ error: 'proposal not found' }); return; }

    const imagesRepo = new OutreachImagesRepository();
    const proposalOrg = normalizeOrg(proposal.org_id);
    let doc: OutreachImageDocument | null = null;
    let resolvedKind: 'default' | 'proposal_custom';
    if (proposal.custom_image_id) {
      doc = await imagesRepo.getById(proposal.custom_image_id);
      resolvedKind = 'proposal_custom';
      if (!doc) {
        // Custom is referenced but missing — fall back to the org default and log loudly.
        Logger.warn(`effective-image: custom_image_id ${proposal.custom_image_id} missing for proposal ${req.params.id}, falling back to ${proposalOrg} default`);
        doc = await imagesRepo.getDefault(proposalOrg);
        resolvedKind = 'default';
      }
    } else {
      doc = await imagesRepo.getDefault(proposalOrg);
      resolvedKind = 'default';
    }

    if (!doc) {
      // Not an error: no image configured for this org → the worker sends
      // text-only (with the marketing video if one is set). 404 is the signal.
      Logger.info(`effective-image[${req.params.id}] no image configured (org=${normalizeOrg(proposal.org_id)}) → worker will send text/video-only`);
      res.status(404).json({ error: 'no default image and no custom set' });
      return;
    }

    Logger.info(`effective-image[${req.params.id}] resolved=${resolvedKind} filename=${doc.filename} size=${doc.size_bytes}`);
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('X-Filename', encodeURIComponent(doc.filename));
    res.setHeader('X-Image-Kind', resolvedKind);
    res.setHeader('Content-Length', String(doc.size_bytes));
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(doc.data.buffer);
  } catch (err) {
    Logger.error('effective-image GET failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /crm/api/outreach/:id/effective-video-url — worker-only
// Presigned GET URLs for the PROPOSAL'S OWN org's queued videos (send order),
// or an empty array when none are set (the worker's signal to send image-only).
// Org is derived from the proposal, never from the caller's header/env — a
// worker must not be able to fetch another org's videos just by asking.
router.get('/:id/effective-video-url', async (req: Request, res: Response) => {
  try {
    const proposalRepo = new OutreachRepository();
    const proposal = await proposalRepo.getById(req.params.id);
    if (!proposal) { res.status(404).json({ error: 'proposal not found' }); return; }

    const proposalOrg = normalizeOrg(proposal.org_id);
    const videos = await new OutreachVideoRepository().listAll(proposalOrg);
    if (videos.length === 0) { res.json({ videos: [] }); return; }
    const r2 = new R2StorageService();
    if (!r2.isConfigured()) {
      res.status(503).json({ error: 'R2 storage not configured' });
      return;
    }
    const urls = await Promise.all(videos.map(async (v) => ({
      url: await r2.generatePresignedGet(v.r2_key),
      mime_type: v.mime_type,
      size_bytes: v.size_bytes,
    })));
    res.json({ videos: urls });
  } catch (err) {
    Logger.error('effective-video-url GET failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /crm/api/outreach/failed-numbers — phone-level failed/suppressed list (CRM,
// developer/manager). Deduped by phone; nothing is ever deleted.
router.get('/failed-numbers', async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const limit = Math.min(parseInt((req.query.limit as string) || '200', 10) || 200, 500);
    const offset = Math.max(0, parseInt((req.query.offset as string) || '0', 10) || 0);
    const query: SuppressionListQuery = { limit, offset };
    if (req.query.kind) query.kind = req.query.kind as SuppressionKind;
    if (req.query.status) query.status = req.query.status as SuppressionStatus;
    if (req.query.follower) query.follower = req.query.follower as string;
    if (req.query.q) query.q = req.query.q as string;

    const { rows, total, counts } = await new OutreachSuppressionRepository().list(query, org);
    const enriched = rows.map((r) => ({
      customer_phone: r.customer_phone,
      phone_display: formatPhoneDisplay(r.customer_phone),
      telegram_link: formatTelegramLink(r.customer_phone),
      customer_name: r.customer_name,
      follower: r.follower,
      failure_kind: r.failure_kind,
      status: r.status,
      retries_used: r.retries_used,
      next_retry_at: r.next_retry_at,
      last_failed_at: r.last_failed_at,
      last_failed_reason: r.last_failed_reason,
      first_failed_at: r.first_failed_at,
    }));
    res.json({ rows: enriched, total, counts });
  } catch (err) {
    Logger.error('failed-numbers list failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /crm/api/outreach/reapprove-deferred-today — bring today's send-timeout
// and import-deferred failures back into the approved queue instead of
// waiting out the 30-day deferred park. These reasons mean our own MTProto/
// network connection failed mid-send, not that the number is unreachable
// (see OutreachRepository.reapproveDeferredToday). Scoped to proposals
// drafted today (Cambodia calendar day) so a stale backlog isn't dumped back
// in all at once.
router.post('/reapprove-deferred-today', express.json(), async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const range = getZonedDayRangeUtc(getTodayDate('Asia/Phnom_Penh'), 'Asia/Phnom_Penh');
    if (!range) { res.status(500).json({ error: 'failed to compute today\'s date range' }); return; }
    const approver = getSessionUser(req) || 'reapprove-deferred';
    const count = await new OutreachRepository().reapproveDeferredToday(org, approver, range.start);
    Logger.info(`[outreach] reapprove-deferred-today org=${org} -> ${count} reapproved`);
    res.json({ org, reapproved_count: count });
  } catch (err) {
    Logger.error('outreach reapprove-deferred-today failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
