import express, { Request, Response } from 'express';
import multer from 'multer';
import * as handlebars from 'handlebars';
import * as fs from 'fs/promises';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { SalesCaseRepository } from '../database/repository';
import { LeadEventDocument } from '../database/models';
import { REASON_CODES } from '../constants/reason-codes';
import { GroupConfigManager } from '../utils/group-config';
import { formatTelegramLink, formatPhoneDisplay } from '../utils/phone-utils';
import { Logger } from '../utils/logger';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function getRepository(): SalesCaseRepository {
  return new SalesCaseRepository();
}

// GET /crm — serve the dashboard HTML
router.get('/', async (_req: Request, res: Response) => {
  try {
    const templatePath = path.join(__dirname, '..', 'reports', 'templates', 'crm-dashboard.hbs');
    const templateContent = await fs.readFile(templatePath, 'utf-8');

    const groupConfig = GroupConfigManager.getInstance();
    const followers = groupConfig.getAllFollowerNames();

    const template = handlebars.compile(templateContent);
    const html = template({
      followers,
      reasonCodes: REASON_CODES
    });

    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    Logger.error('Error serving CRM dashboard', error as Error);
    res.status(500).json({ error: 'Failed to load dashboard', message: (error as Error).message });
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

export default router;
