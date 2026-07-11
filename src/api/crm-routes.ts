import express, { Request, Response } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { SalesCaseRepository } from '../database/repository';
import { LeadEventDocument } from '../database/models';
import { REASON_CODES } from '../constants/reason-codes';
import { GroupConfigManager } from '../utils/group-config';
import { formatTelegramLink, formatPhoneDisplay } from '../utils/phone-utils';
import { Logger } from '../utils/logger';
import { renderPage } from './template-helper';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function getRepository(): SalesCaseRepository {
  return new SalesCaseRepository();
}

// GET /crm — customers page
router.get('/', async (_req: Request, res: Response) => {
  try {
    const groupConfig = GroupConfigManager.getInstance();
    const html = await renderPage('crm/customers', {
      followers: groupConfig.getAllFollowerNames(),
      reasonCodes: REASON_CODES,
      reasonCodesJson: JSON.stringify(REASON_CODES),
    });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving CRM customers page', error as Error);
    res.status(500).json({ error: 'Failed to load dashboard', message: (error as Error).message });
  }
});

// GET /crm/groups — groups page
router.get('/groups', async (_req: Request, res: Response) => {
  try {
    const html = await renderPage('crm/groups', {});
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving CRM groups page', error as Error);
    res.status(500).json({ error: 'Failed to load groups page', message: (error as Error).message });
  }
});

// GET /crm/reports — reports page
router.get('/reports', async (_req: Request, res: Response) => {
  try {
    const html = await renderPage('crm/reports', {});
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving CRM reports page', error as Error);
    res.status(500).json({ error: 'Failed to load reports page', message: (error as Error).message });
  }
});

// GET /crm/import — import page
router.get('/import', async (_req: Request, res: Response) => {
  try {
    const html = await renderPage('crm/import', {});
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving CRM import page', error as Error);
    res.status(500).json({ error: 'Failed to load import page', message: (error as Error).message });
  }
});

// GET /crm/outreach — outreach queue page
router.get('/outreach', async (_req: Request, res: Response) => {
  try {
    const html = await renderPage('crm/outreach', {});
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving CRM outreach page', error as Error);
    res.status(500).json({ error: 'Failed to load outreach page', message: (error as Error).message });
  }
});

// GET /crm/failed-numbers — failed / privacy-blocked numbers list
router.get('/failed-numbers', async (_req: Request, res: Response) => {
  try {
    const html = await renderPage('crm/failed-numbers', {});
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving CRM failed-numbers page', error as Error);
    res.status(500).json({ error: 'Failed to load failed-numbers page', message: (error as Error).message });
  }
});

// GET /crm/brain — AI brain document manager
router.get('/brain', async (_req: Request, res: Response) => {
  try {
    const html = await renderPage('crm/brain', {});
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving CRM brain page', error as Error);
    res.status(500).json({ error: 'Failed to load brain page', message: (error as Error).message });
  }
});

// GET /crm/api/customers — JSON customer data with filters
router.get('/api/customers', async (req: Request, res: Response) => {
  try {
    const repository = getRepository();
    const follower = req.query.follower as string | undefined;
    const filter = (req.query.filter as string) || 'all';
    const reason = req.query.reason as string | undefined;
    const days = parseInt(req.query.days as string) || 14;
    const temperatureFilter = req.query.temperature as string | undefined;

    let cases;
    const followerParam = follower && follower !== 'all' ? follower : undefined;

    switch (filter) {
      case 'stale':
        cases = await repository.getStaleCustomers(days, followerParam);
        break;
      case 'reason':
        if (!reason) {
          res.status(400).json({ error: 'reason parameter required for reason filter' });
          return;
        }
        cases = await repository.getCustomersByReason(reason, followerParam);
        break;
      default:
        cases = await repository.getAllCustomers(followerParam);
    }

    // Optional temperature filter applied in-memory to stay compatible with all base filters
    if (temperatureFilter && ['hot', 'warm', 'cold'].includes(temperatureFilter)) {
      cases = cases.filter((c) => c.current_temperature === temperatureFilter);
    }

    // Enrich with Telegram links
    const enriched = cases.map(c => ({
      ...c,
      temperature: c.current_temperature ?? null,
      telegram_link: c.phone ? formatTelegramLink(c.phone) : null,
      phone_display: c.phone ? formatPhoneDisplay(c.phone) : null,
      days_since_contact: c.last_update_date
        ? Math.floor((Date.now() - new Date(c.last_update_date).getTime()) / (1000 * 60 * 60 * 24))
        : null
    }));

    const samplePhones = enriched.slice(0, 5).map(c => c.phone);
    const hasMarker = enriched.some(c => c.phone === '+85570597666' || c.phone === '+85586226225');
    Logger.info(
      `[crm-customers] filter=${filter} follower=${followerParam ?? 'all'} temp=${temperatureFilter ?? 'all'} returned=${enriched.length} sample=${JSON.stringify(samplePhones)} hasMarker=${hasMarker}`
    );

    res.json({ customers: enriched, total: enriched.length });
  } catch (error) {
    Logger.error('Error fetching CRM customers', error as Error);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// GET /crm/api/groups-config — sales + admin group chat ID restrictions
router.get('/api/groups-config', (_req: Request, res: Response) => {
  try {
    const groupConfig = GroupConfigManager.getInstance();
    const sales = groupConfig.getAllActiveGroups().map(g => ({
      groupId: g.groupId,
      name: g.name,
      chatId: g.chatId,
      type: 'sales' as const
    }));

    const admin: Array<{ groupId: string; name: string; chatId: string; type: 'admin' }> = [];
    if (process.env.SUMMARY_CHAT_ID) {
      admin.push({ groupId: 'summary', name: 'Summary (Management)', chatId: process.env.SUMMARY_CHAT_ID, type: 'admin' });
    }
    if (process.env.AUDIT_CHAT_ID) {
      admin.push({ groupId: 'audit', name: 'Audit (Auto Reports)', chatId: process.env.AUDIT_CHAT_ID, type: 'admin' });
    }

    res.json({ sales, admin });
  } catch (error) {
    Logger.error('Error fetching groups config', error as Error);
    res.status(500).json({ error: 'Failed to fetch groups config' });
  }
});

// GET /crm/api/followers — list of follower names
router.get('/api/followers', (_req: Request, res: Response) => {
  try {
    const groupConfig = GroupConfigManager.getInstance();
    const followers = groupConfig.getAllFollowerNames();
    res.json({ followers });
  } catch (error) {
    res.json({ followers: [] });
  }
});

// GET /crm/api/reasons — list of reason codes
router.get('/api/reasons', (_req: Request, res: Response) => {
  res.json({ reasons: REASON_CODES });
});

// POST /crm/api/import — upload CSV/Excel file
router.post('/api/import', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const buffer = req.file.buffer;
    const filename = req.file.originalname.toLowerCase();
    let rows: any[] = [];

    const workbook = new ExcelJS.Workbook();

    if (filename.endsWith('.csv')) {
      await workbook.csv.read(require('stream').Readable.from(buffer));
    } else if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
      await workbook.xlsx.load(buffer as any);
    } else {
      res.status(400).json({ error: 'Unsupported file type. Use .csv or .xlsx' });
      return;
    }

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      res.status(400).json({ error: 'Empty file — no worksheets found' });
      return;
    }

    // Get headers from first row
    const headerRow = worksheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell((cell, colNumber) => {
      headers[colNumber - 1] = String(cell.value || '').toLowerCase().trim();
    });

    // Parse data rows
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // skip header
      const record: any = {};
      row.eachCell((cell, colNumber) => {
        const header = headers[colNumber - 1];
        if (header) {
          record[header] = cell.value !== null && cell.value !== undefined ? String(cell.value).trim() : null;
        }
      });
      if (record.phone) {
        rows.push(record);
      }
    });

    // Return preview
    res.json({
      preview: true,
      total: rows.length,
      sample: rows.slice(0, 5),
      headers: headers.filter(Boolean),
      rows
    });
  } catch (error) {
    Logger.error('Error parsing import file', error as Error);
    res.status(500).json({ error: 'Failed to parse file', message: (error as Error).message });
  }
});

// POST /crm/api/import/confirm — confirm and insert parsed rows
router.post('/api/import/confirm', express.json(), async (req: Request, res: Response) => {
  try {
    const { rows } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: 'No rows to import' });
      return;
    }

    const repository = getRepository();
    const today = new Date().toISOString().slice(0, 10);
    let imported = 0;
    let skipped = 0;

    const leadEvents: LeadEventDocument[] = [];

    for (const row of rows) {
      if (!row.phone) {
        skipped++;
        continue;
      }

      const event: LeadEventDocument = {
        date: row.date || today,
        customer: {
          name: row.name || null,
          phone: row.phone
        },
        page: row.page || null,
        destination: row.destination || null,
        follower: row.follower || null,
        status_text: null,
        reason_code: row.reason_code || null,
        note: row.note || null,
        promise_date: row.promise_date || null,
        promise_status: row.promise_date ? 'pending' : null,
        group_id: null,
        source: {
          telegram_msg_id: 'csv-import',
          model: 'csv-import'
        },
        created_at: new Date()
      };

      leadEvents.push(event);
      imported++;
    }

    if (leadEvents.length > 0) {
      await repository.saveLeadEvents(leadEvents);
    }

    await repository.logAudit({
      timestamp: new Date(),
      action: 'csv-import',
      message_id: 0,
      user_id: 0,
      username: 'dashboard',
      original_message: `Imported ${imported} records from CSV/Excel`,
      parsed_result: { imported, skipped }
    });

    res.json({ success: true, imported, skipped });
  } catch (error) {
    Logger.error('Error confirming import', error as Error);
    res.status(500).json({ error: 'Failed to import records' });
  }
});

// PATCH /crm/api/customers/:phone — edit follower / reason_code / note on latest event
router.patch('/api/customers/:phone', express.json(), async (req: Request, res: Response) => {
  const phone = decodeURIComponent(req.params.phone);
  const { follower, reason_code, note } = req.body || {};
  Logger.info(`PATCH /crm/api/customers/${phone} with ${JSON.stringify({ follower, reason_code, note })}`);

  try {
    const groupConfig = GroupConfigManager.getInstance();

    if (follower !== undefined && follower !== null) {
      const validFollowers = groupConfig.getAllFollowerNames();
      if (!validFollowers.includes(follower)) {
        res.status(400).json({ error: `Invalid follower: ${follower}` });
        return;
      }
    }

    if (reason_code !== undefined && reason_code !== null) {
      const validCode = REASON_CODES.find(r => r.code === reason_code);
      if (!validCode) {
        res.status(400).json({ error: `Invalid reason_code: ${reason_code}` });
        return;
      }
    }

    const updates: { follower?: string | null; reason_code?: string | null; note?: string | null } = {};
    if ('follower' in req.body) updates.follower = follower ?? null;
    if ('reason_code' in req.body) updates.reason_code = reason_code ?? null;
    if ('note' in req.body) updates.note = note ?? null;

    const repository = getRepository();
    const result = await repository.updateCustomerLatest(phone, updates, 'dashboard');

    if (!result.success) {
      if (result.error === 'Customer not found') {
        res.status(404).json(result);
        return;
      }
      Logger.error(`updateCustomerLatest failed for ${phone}: ${result.error}`);
      res.status(500).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    Logger.error(`Error in PATCH /crm/api/customers/${phone}`, error as Error);
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

// DELETE /crm/api/customers/:phone — soft-delete all events for a customer
router.delete('/api/customers/:phone', async (req: Request, res: Response) => {
  const phone = decodeURIComponent(req.params.phone);
  Logger.info(`DELETE /crm/api/customers/${phone}`);

  try {
    const repository = getRepository();
    const result = await repository.softDeleteCustomerByPhone(phone, 'dashboard');

    if (!result.success) {
      if (result.error === 'Customer not found') {
        res.status(404).json(result);
        return;
      }
      Logger.error(`softDeleteCustomerByPhone failed for ${phone}: ${result.error}`);
      res.status(500).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    Logger.error(`Error in DELETE /crm/api/customers/${phone}`, error as Error);
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

export default router;
