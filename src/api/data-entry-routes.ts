import express, { Request, Response } from 'express';
import { SalesCaseRepository } from '../database/repository';
import { LeadEventDocument } from '../database/models';
import { REASON_CODES } from '../constants/reason-codes';
import { DESTINATION_OPTIONS } from '../constants/destination-options';
import { GroupConfigManager } from '../utils/group-config';
import { formatTelegramLink, formatPhoneDisplay } from '../utils/phone-utils';
import { Logger } from '../utils/logger';
import { renderPage } from './template-helper';

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

// GET /data-entry — serve the dashboard HTML
router.get('/', async (req: Request, res: Response) => {
  try {
    const groupConfig = GroupConfigManager.getInstance();
    const followers = groupConfig.getAllFollowerNames();

    const html = await renderPage('data-entry', {
      followers,
      reasonCodes: REASON_CODES,
      destinationOptions: DESTINATION_OPTIONS,
      token: (req.query.token as string) || '',
      followersJson: JSON.stringify(followers),
      reasonsJson: JSON.stringify(REASON_CODES.map(r => r.code)),
      destOptionsJson: JSON.stringify(DESTINATION_OPTIONS.map(d => d.label)),
      activeNav: 'data-entry',
    });

    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving Data Entry dashboard', error as Error);
    res.status(500).json({ error: 'Failed to load dashboard', message: (error as Error).message });
  }
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

// POST /data-entry/api/events — create a new lead event
router.post('/api/events', express.json(), async (req: Request, res: Response) => {
  try {
    const repository = getRepository();
    const { date, customer_name, customer_phone, page, destination, follower, reason_code, note, promise_date } = req.body;

    if (!customer_phone) {
      res.status(400).json({ error: 'Customer phone is required' });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const eventDate = date || today;
    if (!isValidDate(eventDate)) {
      res.status(400).json({ error: 'Date must be in YYYY-MM-DD format' });
      return;
    }
    const event: LeadEventDocument = {
      date: eventDate,
      customer: {
        name: customer_name || null,
        phone: customer_phone
      },
      page: page || null,
      destination: destination || null,
      follower: follower || null,
      status_text: null,
      reason_code: reason_code || null,
      note: note || null,
      promise_date: promise_date || null,
      promise_status: promise_date ? 'pending' : null,
      group_id: null,
      source: {
        telegram_msg_id: 'dashboard',
        model: 'dashboard'
      },
      created_at: new Date()
    };

    const eventId = await repository.saveLeadEvent(event);

    // Save change log
    await repository.saveChangeLog({
      timestamp: new Date(),
      action: 'create',
      event_id: eventId,
      event_summary: buildEventSummary(event),
      actor: 'dashboard'
    });

    // Audit log
    await repository.logAudit({
      timestamp: new Date(),
      action: 'dashboard-create',
      message_id: 0,
      user_id: 0,
      username: 'dashboard',
      original_message: `Created event for ${customer_name || customer_phone}`,
      parsed_result: { eventId }
    });

    res.json({ success: true, eventId });
  } catch (error) {
    Logger.error('Error creating event', error as Error);
    res.status(500).json({ error: 'Failed to create event' });
  }
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

export default router;
