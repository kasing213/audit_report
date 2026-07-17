import express, { Request, Response } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { SalesCaseRepository } from '../database/repository';
import { LeadEventDocument } from '../database/models';
import { REASON_CODES } from '../constants/reason-codes';
import { GroupConfigManager } from '../utils/group-config';
import { formatTelegramLink, formatPhoneDisplay, toInternationalPhone } from '../utils/phone-utils';
import { generateBatch } from '../outreach/outreach-agent';
import { resolveOrg, ORG_COOKIE_NAME } from '../outreach/org-context';
import { OUTREACH_ORGS, normalizeOrg } from '../outreach/orgs';
import { Logger } from '../utils/logger';
import { renderPage } from './template-helper';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const ORG_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function getRepository(): SalesCaseRepository {
  return new SalesCaseRepository();
}

// Common template context so every CRM page shows the org switcher and reflects
// the active workspace. Merge into each page's renderPage data.
function withOrg(req: Request): { activeOrg: string; orgs: typeof OUTREACH_ORGS } {
  return { activeOrg: resolveOrg(req), orgs: OUTREACH_ORGS };
}

// GET /crm/set-org?org=personal — flip the active workspace, then return to the
// page the switcher was clicked from. The cookie is what resolveOrg reads for all
// browser API calls, so nothing else needs to change client-side.
router.get('/set-org', (req: Request, res: Response) => {
  const org = normalizeOrg(req.query.org);
  res.cookie(ORG_COOKIE_NAME, org, { path: '/', maxAge: ORG_COOKIE_MAX_AGE_MS, sameSite: 'lax' });
  const referer = req.get('referer');
  res.redirect(referer || '/crm');
});

// Parse one QuickBook report line: "060-Pkarikkongsuon 092 462911"
// → { name: "Pkarikkongsuon", phone: "+85592462911" }. Returns null if no phone → reject row.
function extractQuickBookRecord(text: string): { name: string | null; phone: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // strip leading sequence id like "060-" or "6." (1-3 digits + separator)
  const idMatch = trimmed.match(/^\s*\d{1,3}\s*[-.]\s*/);
  const body = idMatch ? trimmed.slice(idMatch[0].length) : trimmed;
  // find first digit run that is a Cambodian phone (8-11 digits, spaces/dots/dashes allowed)
  for (const m of body.matchAll(/\d[\d\s.\-]{5,}\d/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 11) {
      const name = body.slice(0, m.index).trim();
      return { name: name || null, phone: toInternationalPhone(digits) };
    }
  }
  return null; // no number in the row → reject
}

// GET /crm — customers page
router.get('/', async (req: Request, res: Response) => {
  try {
    const groupConfig = GroupConfigManager.getInstance();
    const html = await renderPage('crm/customers', {
      ...withOrg(req),
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
router.get('/groups', async (req: Request, res: Response) => {
  try {
    const html = await renderPage('crm/groups', { ...withOrg(req) });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving CRM groups page', error as Error);
    res.status(500).json({ error: 'Failed to load groups page', message: (error as Error).message });
  }
});

// GET /crm/reports — reports page
router.get('/reports', async (req: Request, res: Response) => {
  try {
    const html = await renderPage('crm/reports', { ...withOrg(req) });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving CRM reports page', error as Error);
    res.status(500).json({ error: 'Failed to load reports page', message: (error as Error).message });
  }
});

// GET /crm/import — import page
router.get('/import', async (req: Request, res: Response) => {
  try {
    const html = await renderPage('crm/import', { ...withOrg(req) });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving CRM import page', error as Error);
    res.status(500).json({ error: 'Failed to load import page', message: (error as Error).message });
  }
});

// GET /crm/import-outreach — import + push straight to outreach pending
router.get('/import-outreach', async (req: Request, res: Response) => {
  try {
    const html = await renderPage('crm/import-outreach', { ...withOrg(req) });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving CRM import-outreach page', error as Error);
    res.status(500).json({ error: 'Failed to load import-outreach page', message: (error as Error).message });
  }
});

// GET /crm/quickbook-customers — paginated dashboard of QuickBook-imported customers
router.get('/quickbook-customers', async (req: Request, res: Response) => {
  try {
    const html = await renderPage('crm/quickbook-customers', {
      ...withOrg(req),
      reasonCodesJson: JSON.stringify(REASON_CODES)
    });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving QuickBook customers page', error as Error);
    res.status(500).json({ error: 'Failed to load QuickBook customers page', message: (error as Error).message });
  }
});

// GET /crm/outreach — outreach queue page
router.get('/outreach', async (req: Request, res: Response) => {
  try {
    const html = await renderPage('crm/outreach', { ...withOrg(req) });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving CRM outreach page', error as Error);
    res.status(500).json({ error: 'Failed to load outreach page', message: (error as Error).message });
  }
});

// GET /crm/failed-numbers — failed / privacy-blocked numbers list
router.get('/failed-numbers', async (req: Request, res: Response) => {
  try {
    const html = await renderPage('crm/failed-numbers', { ...withOrg(req) });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving CRM failed-numbers page', error as Error);
    res.status(500).json({ error: 'Failed to load failed-numbers page', message: (error as Error).message });
  }
});

// GET /crm/brain — AI brain document manager
router.get('/brain', async (req: Request, res: Response) => {
  try {
    const html = await renderPage('crm/brain', { ...withOrg(req) });
    res.set('Content-Type', 'text/html').send(html);
  } catch (error) {
    Logger.error('Error serving CRM brain page', error as Error);
    res.status(500).json({ error: 'Failed to load brain page', message: (error as Error).message });
  }
});

// GET /crm/api/customers — JSON customer data with filters
router.get('/api/customers', async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
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
        cases = await repository.getStaleCustomers(days, followerParam, org);
        break;
      case 'reason':
        if (!reason) {
          res.status(400).json({ error: 'reason parameter required for reason filter' });
          return;
        }
        cases = await repository.getCustomersByReason(reason, followerParam, org);
        break;
      default:
        cases = await repository.getAllCustomers(followerParam, org);
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

// GET /crm/api/quickbook-customers?page=N — paginated (20/page) list of customers
// imported from a QuickBook/spreadsheet file (source.model = 'csv-import').
router.get('/api/quickbook-customers', async (req: Request, res: Response) => {
  try {
    const org = resolveOrg(req);
    const pageSize = 20;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const repository = getRepository();
    const { customers, total } = await repository.getQuickBookCustomers(page, pageSize, org);

    // Same enrichment as /api/customers so the row rendering is identical.
    const enriched = customers.map(c => ({
      ...c,
      temperature: c.current_temperature ?? null,
      telegram_link: c.phone ? formatTelegramLink(c.phone) : null,
      phone_display: c.phone ? formatPhoneDisplay(c.phone) : null,
      days_since_contact: c.last_update_date
        ? Math.floor((Date.now() - new Date(c.last_update_date).getTime()) / (1000 * 60 * 60 * 24))
        : null
    }));

    res.json({ customers: enriched, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  } catch (error) {
    Logger.error('Error fetching QuickBook customers', error as Error);
    res.status(500).json({ error: 'Failed to fetch QuickBook customers' });
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

    let responseHeaders = headers.filter(Boolean);
    const hasPhoneHeader = headers.includes('phone');

    if (hasPhoneHeader) {
      // Standard CSV/Excel with a phone column
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
    } else {
      // QuickBook report export: no header, "ID-Name Phone" jammed into one text column.
      // Extract name + phone from each row's text; reject rows with no phone number.
      //
      // These are old leads (years old at export) with no real dates in the file. Backdate
      // them to the outreach stale threshold (45 days) so they immediately count as stale
      // and get staged into the outreach pipeline instead of looking brand-new.
      const STALE_DAYS = 45; // matches DEFAULT_STALE_DAYS in outreach-agent.ts
      const staleDate = new Date();
      staleDate.setDate(staleDate.getDate() - STALE_DAYS);
      const staleDateStr = staleDate.toISOString().slice(0, 10);
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // skip potential header/title row
        const parts: string[] = [];
        row.eachCell({ includeEmpty: false }, (cell) => {
          if (cell.value !== null && cell.value !== undefined) parts.push(String(cell.value).trim());
        });
        const record = extractQuickBookRecord(parts.join(' '));
        if (record) {
          rows.push({ ...record, date: staleDateStr });
        }
      });
      responseHeaders = ['name', 'phone', 'date'];
    }

    // Return preview
    res.json({
      preview: true,
      total: rows.length,
      sample: rows.slice(0, 5),
      headers: responseHeaders,
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

    const org = resolveOrg(req);
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
        org_id: org,
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

// POST /crm/api/import/confirm-outreach — insert parsed rows AND stage every one as a
// PENDING outreach proposal. Used for no-sales-name QuickBook lists: import (rows already
// carry the 45-day backdate) then push straight to the outreach Pending tab for approval.
router.post('/api/import/confirm-outreach', express.json(), async (req: Request, res: Response) => {
  try {
    const { rows } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: 'No rows to import' });
      return;
    }

    const org = resolveOrg(req);
    const repository = getRepository();
    const today = new Date().toISOString().slice(0, 10);
    let imported = 0;
    let skipped = 0;

    const leadEvents: LeadEventDocument[] = [];
    const phones: string[] = [];

    for (const row of rows) {
      if (!row.phone) {
        skipped++;
        continue;
      }

      leadEvents.push({
        date: row.date || today,
        org_id: org,
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
      });
      phones.push(row.phone);
      imported++;
    }

    // Save the lead events FIRST so generateBatch's getAllCustomers() sees them.
    if (leadEvents.length > 0) {
      await repository.saveLeadEvents(leadEvents);
    }

    // Stage every imported phone as a PENDING proposal for this org (limit = all rows,
    // bypassing the default 20/batch cap). Static template, held for approval in /crm/outreach.
    const generation = await generateBatch({ phones, limit: phones.length, orgId: org });

    await repository.logAudit({
      timestamp: new Date(),
      action: 'csv-import-outreach',
      message_id: 0,
      user_id: 0,
      username: 'dashboard',
      original_message: `Imported ${imported} records and staged ${generation.created} outreach proposals`,
      parsed_result: { imported, skipped, staged: generation.created, staged_skipped: generation.skipped }
    });

    res.json({ success: true, imported, skipped, staged: generation.created, staged_skipped: generation.skipped });
  } catch (error) {
    Logger.error('Error confirming import-outreach', error as Error);
    res.status(500).json({ error: 'Failed to import and stage records' });
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
