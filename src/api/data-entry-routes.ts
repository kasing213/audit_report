import express, { Request, Response } from 'express';
import { SalesCaseRepository } from '../database/repository';
import { LeadEventDocument, DailySummaryDocument } from '../database/models';
import { REASON_CODES, isReasonCode } from '../constants/reason-codes';
import { DESTINATION_OPTIONS } from '../constants/destination-options';
import { GroupConfigManager } from '../utils/group-config';
import { formatTelegramLink, formatPhoneDisplay } from '../utils/phone-utils';
import { Logger } from '../utils/logger';
import { renderPage } from './template-helper';
import { parseBulkReport } from '../parser/bulk-report-parser';

const router = express.Router();

function getRepository(): SalesCaseRepository {
  return new SalesCaseRepository();
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(str: string): boolean {
  return DATE_REGEX.test(str);
}

function buildEventSummary(event: LeadEventDocument) {
  return {
    customer_name: event.customer?.name || null,
    customer_phone: event.customer?.phone || null,
    date: event.date,
    follower: event.follower || null
  };
}

// GET /data-entry — solo entry form was removed; redirect to bulk-only entry surface.
router.get('/', (_req: Request, res: Response) => {
  res.redirect(302, '/data-entry/bulk');
});

// GET /data-entry/api/options — all form options in one call
router.get('/api/options', (_req: Request, res: Response) => {
  try {
    const groupConfig = GroupConfigManager.getInstance();
    const followers = groupConfig.getAllFollowerNames();
    res.json({ followers, reasonCodes: REASON_CODES, destinationOptions: DESTINATION_OPTIONS });
  } catch (error) {
    res.json({ followers: [], reasonCodes: REASON_CODES, destinationOptions: DESTINATION_OPTIONS });
  }
});

// GET /data-entry/api/events — list events by date range
router.get('/api/events', async (req: Request, res: Response) => {
  try {
    const repository = getRepository();
    const startDate = req.query.start as string;
    const endDate = req.query.end as string;
    const follower = req.query.follower as string | undefined;
    const phone = req.query.phone as string | undefined;

    if (!startDate || !endDate) {
      res.status(400).json({ error: 'start and end date parameters required' });
      return;
    }
    if (!isValidDate(startDate) || !isValidDate(endDate)) {
      res.status(400).json({ error: 'Dates must be in YYYY-MM-DD format' });
      return;
    }

    const events = await repository.getEventsByDateRange(
      startDate,
      endDate,
      follower && follower !== 'all' ? follower : undefined,
      phone || undefined
    );

    const enriched = events.map(e => ({
      ...e,
      telegram_link: e.customer?.phone ? formatTelegramLink(e.customer.phone) : null,
      phone_display: e.customer?.phone ? formatPhoneDisplay(e.customer.phone) : null
    }));

    res.json({ events: enriched, total: enriched.length });
  } catch (error) {
    Logger.error('Error fetching events', error as Error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// POST /data-entry/api/events — create endpoint was removed alongside the solo
// entry form. Use the bulk paste flow at /data-entry/bulk to add new events.
router.post('/api/events', (_req: Request, res: Response) => {
  res.status(410).json({ error: 'Solo create removed; use POST /data-entry/api/bulk/confirm.' });
});

// GET /data-entry/api/events/:id — get single event
router.get('/api/events/:id', async (req: Request, res: Response) => {
  try {
    const repository = getRepository();
    const event = await repository.findEventById(req.params.id);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    res.json({ event });
  } catch (error) {
    Logger.error('Error fetching event', error as Error);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// PUT /data-entry/api/events/:id — update event
router.put('/api/events/:id', express.json(), async (req: Request, res: Response) => {
  try {
    const repository = getRepository();
    const existing = await repository.findEventById(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const updates: Partial<LeadEventDocument> = {};
    const changes: Array<{ field: string; old_value: any; new_value: any }> = [];

    // Map flat request fields to nested document structure
    const fieldMap: Record<string, { path: string; getValue: (e: LeadEventDocument) => any; setValue: (u: any, v: any) => void }> = {
      date: {
        path: 'date',
        getValue: e => e.date,
        setValue: (u, v) => { u.date = v; }
      },
      customer_name: {
        path: 'customer.name',
        getValue: e => e.customer?.name,
        setValue: (u, v) => { u.customer = { ...(u.customer || existing.customer), name: v }; }
      },
      customer_phone: {
        path: 'customer.phone',
        getValue: e => e.customer?.phone,
        setValue: (u, v) => { u.customer = { ...(u.customer || existing.customer), phone: v }; }
      },
      page: {
        path: 'page',
        getValue: e => e.page,
        setValue: (u, v) => { u.page = v; }
      },
      destination: {
        path: 'destination',
        getValue: e => e.destination,
        setValue: (u, v) => { u.destination = v; }
      },
      follower: {
        path: 'follower',
        getValue: e => e.follower,
        setValue: (u, v) => { u.follower = v; }
      },
      reason_code: {
        path: 'reason_code',
        getValue: e => e.reason_code,
        setValue: (u, v) => { u.reason_code = v; }
      },
      note: {
        path: 'note',
        getValue: e => e.note,
        setValue: (u, v) => { u.note = v; }
      },
      promise_date: {
        path: 'promise_date',
        getValue: e => e.promise_date,
        setValue: (u, v) => { u.promise_date = v; if (v) u.promise_status = 'pending'; }
      },
      promise_status: {
        path: 'promise_status',
        getValue: e => e.promise_status,
        setValue: (u, v) => { u.promise_status = v; }
      }
    };

    for (const [key, config] of Object.entries(fieldMap)) {
      if (req.body[key] !== undefined) {
        const oldVal = config.getValue(existing);
        const newVal = req.body[key] || null;
        if (oldVal !== newVal) {
          changes.push({ field: config.path, old_value: oldVal, new_value: newVal });
          config.setValue(updates, newVal);
        }
      }
    }

    if (changes.length === 0) {
      res.json({ success: true, message: 'No changes detected' });
      return;
    }

    await repository.updateLeadEvent(req.params.id, updates);

    // Save change log
    await repository.saveChangeLog({
      timestamp: new Date(),
      action: 'update',
      event_id: req.params.id,
      event_summary: buildEventSummary(existing),
      changes,
      actor: 'dashboard'
    });

    // Audit log
    await repository.logAudit({
      timestamp: new Date(),
      action: 'dashboard-update',
      message_id: 0,
      user_id: 0,
      username: 'dashboard',
      original_message: `Updated ${changes.length} field(s) for ${existing.customer?.name || existing.customer?.phone}`,
      parsed_result: { eventId: req.params.id, changes }
    });

    res.json({ success: true, changes: changes.length });
  } catch (error) {
    Logger.error('Error updating event', error as Error);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// DELETE /data-entry/api/events/:id — delete event
router.delete('/api/events/:id', async (req: Request, res: Response) => {
  try {
    const repository = getRepository();
    const existing = await repository.findEventById(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    await repository.deleteLeadEvent(req.params.id);

    // Save change log with full snapshot
    await repository.saveChangeLog({
      timestamp: new Date(),
      action: 'delete',
      event_id: req.params.id,
      event_summary: buildEventSummary(existing),
      snapshot: existing,
      actor: 'dashboard'
    });

    // Audit log
    await repository.logAudit({
      timestamp: new Date(),
      action: 'dashboard-delete',
      message_id: 0,
      user_id: 0,
      username: 'dashboard',
      original_message: `Deleted event for ${existing.customer?.name || existing.customer?.phone}`,
      parsed_result: { eventId: req.params.id }
    });

    res.json({ success: true });
  } catch (error) {
    Logger.error('Error deleting event', error as Error);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// GET /data-entry/api/activity — get change logs for a date
router.get('/api/activity', async (req: Request, res: Response) => {
  try {
    const repository = getRepository();
    const date = req.query.date as string;
    if (!date) {
      res.status(400).json({ error: 'date parameter required' });
      return;
    }
    const logs = await repository.getChangeLogs(date);
    res.json({ logs, total: logs.length });
  } catch (error) {
    Logger.error('Error fetching activity', error as Error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// GET /data-entry/bulk — serve the bulk paste page
router.get('/bulk', async (req: Request, res: Response) => {
  try {
    const groupConfig = GroupConfigManager.getInstance();
    const followers = groupConfig.getAllFollowerNames();

    const html = await renderPage('bulk-data-entry', {
      followers,
      reasonCodes: REASON_CODES,
      token: (req.query.token as string) || '',
      followersJson: JSON.stringify(followers),
      reasonsJson: JSON.stringify(REASON_CODES.map(r => r.code)),
      activeNav: 'bulk-entry',
      title: 'Bulk Data Entry'
    });

    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving Bulk Data Entry page', error as Error);
    res.status(500).json({ error: 'Failed to load bulk entry page', message: (error as Error).message });
  }
});

// POST /data-entry/api/bulk/preview — parse a pasted report into drafts
router.post('/api/bulk/preview', express.json({ limit: '256kb' }), async (req: Request, res: Response) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ error: 'text required' });
      return;
    }

    const parsed = parseBulkReport(text);

    const groupConfig = GroupConfigManager.getInstance();
    const followers = groupConfig.getAllFollowerNames();
    if (parsed.header.follower && !followers.includes(parsed.header.follower)) {
      parsed.warnings.push(`Unknown follower: ${parsed.header.follower}`);
    }

    res.json({
      preview: true,
      header: parsed.header,
      summary: parsed.summary,
      drafts: parsed.drafts,
      warnings: parsed.warnings,
      empty_slots: parsed.empty_slots
    });
  } catch (error) {
    Logger.error('Error in bulk preview', error as Error);
    res.status(500).json({ error: 'Failed to parse report', message: (error as Error).message });
  }
});

// POST /data-entry/api/bulk/confirm — persist drafts + optional daily summary
router.post('/api/bulk/confirm', express.json({ limit: '512kb' }), async (req: Request, res: Response) => {
  try {
    const { header, drafts, summary } = req.body || {};
    if (!header || !header.date || !isValidDate(header.date)) {
      res.status(400).json({ error: 'header.date required (YYYY-MM-DD)' });
      return;
    }
    if (!Array.isArray(drafts)) {
      res.status(400).json({ error: 'drafts must be an array' });
      return;
    }

    const repository = getRepository();
    const events: LeadEventDocument[] = [];
    const ts = Date.now();
    let skipped = 0;

    for (const d of drafts) {
      const phone = (d?.customer_phone || '').trim();
      if (!phone) { skipped++; continue; }
      const eventDate = (d?.date && isValidDate(d.date)) ? d.date : header.date;
      const reasonCode = d?.reason_code && isReasonCode(d.reason_code) ? d.reason_code : null;
      const slot = String(d?.slot || `slot-${events.length + 1}`).slice(0, 40);

      events.push({
        date: eventDate,
        customer: {
          name: d?.customer_name || null,
          phone
        },
        page: d?.page || header.page || null,
        destination: null,
        follower: d?.follower || header.follower || null,
        status_text: null,
        reason_code: reasonCode,
        note: d?.note || null,
        promise_date: d?.promise_date || null,
        promise_status: d?.promise_date ? 'pending' : null,
        group_id: null,
        source: {
          telegram_msg_id: `bulk-${ts}-${slot}`,
          model: 'bulk-paste'
        },
        created_at: new Date()
      });
    }

    const eventIds = events.length ? await repository.saveLeadEvents(events) : [];

    let summaryId: string | null = null;
    if (summary && summary.counters && Object.keys(summary.counters).length > 0) {
      const summaryDoc: DailySummaryDocument = {
        date: header.date,
        follower: header.follower || null,
        page: header.page || null,
        counters: summary.counters,
        raw_text: typeof summary.raw_text === 'string' ? summary.raw_text.slice(0, 20000) : '',
        source: { model: 'bulk-paste' },
        created_at: new Date()
      };
      summaryId = await repository.saveDailySummary(summaryDoc);
    }

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const evId = eventIds[i];
      if (!evId) continue;
      await repository.saveChangeLog({
        timestamp: new Date(),
        action: 'create',
        event_id: evId,
        event_summary: buildEventSummary(ev),
        actor: 'dashboard-bulk'
      });
    }

    await repository.logAudit({
      timestamp: new Date(),
      action: 'bulk-data-entry',
      message_id: 0,
      user_id: 0,
      username: 'dashboard',
      original_message: `Bulk import: ${events.length} events, summary=${summaryId ? 'yes' : 'no'}`,
      parsed_result: { event_ids: eventIds, summary_id: summaryId, imported: events.length, skipped }
    });

    res.json({
      success: true,
      imported: events.length,
      skipped,
      summary_id: summaryId,
      event_ids: eventIds
    });
  } catch (error) {
    Logger.error('Error in bulk confirm', error as Error);
    res.status(500).json({ error: 'Failed to import bulk report', message: (error as Error).message });
  }
});

export default router;
