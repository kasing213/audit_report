import { Router, Request, Response } from 'express';
import express from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { SalesCaseRepository } from '../database/repository';
import { TemperatureClassifier } from '../classifier/temperature-classifier';
import { pushTemperatureEvent } from '../integrations/meta-capi';
import { LeadEventDocument } from '../database/models';
import { Logger } from '../utils/logger';
import { getTodayDate } from '../utils/time';

const GRAPH_API_VERSION = 'v19.0';
const GRAPH_FETCH_TIMEOUT_MS = 10_000;

const router = Router();
const repository = new SalesCaseRepository();
const classifier = new TemperatureClassifier();

// Capture the raw body so we can verify Meta's HMAC signature. We must add this
// BEFORE express.json() on this router — the global server-level json parser
// still applies to other routes.
router.use(express.json({
  verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));

function verifySignature(req: Request & { rawBody?: Buffer }): boolean {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    Logger.warn('META_APP_SECRET not set — rejecting webhook');
    return false;
  }
  const header = req.get('x-hub-signature-256');
  if (!header || !header.startsWith('sha256=')) return false;
  const signatureHex = header.slice('sha256='.length);

  const computed = createHmac('sha256', appSecret)
    .update(req.rawBody ?? Buffer.from(''))
    .digest('hex');

  try {
    return timingSafeEqual(Buffer.from(signatureHex, 'hex'), Buffer.from(computed, 'hex'));
  } catch {
    return false;
  }
}

// GET: handshake verification
router.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN && typeof challenge === 'string') {
    res.status(200).send(challenge);
    return;
  }
  res.sendStatus(403);
});

interface GraphLeadField {
  name: string;
  values: string[];
}

interface GraphLead {
  id: string;
  created_time?: string;
  field_data?: GraphLeadField[];
  ad_id?: string;
  form_id?: string;
  page_id?: string;
}

async function fetchLeadFromGraph(leadId: string): Promise<GraphLead | null> {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) {
    Logger.warn('META_PAGE_ACCESS_TOKEN not set — cannot fetch lead from Graph API');
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GRAPH_FETCH_TIMEOUT_MS);

  try {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${leadId}?access_token=${encodeURIComponent(token)}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const body = await response.text();
      Logger.error(`Graph lead fetch non-2xx (${response.status}): ${body.substring(0, 200)}`);
      return null;
    }
    return (await response.json()) as GraphLead;
  } catch (error) {
    Logger.error('Graph lead fetch failed', error as Error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractField(lead: GraphLead, names: string[]): string | null {
  if (!lead.field_data) return null;
  for (const name of names) {
    const match = lead.field_data.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (match && match.values && match.values.length > 0) {
      return match.values[0];
    }
  }
  return null;
}

// POST: lead notifications
router.post('/', async (req: Request & { rawBody?: Buffer }, res: Response) => {
  if (!verifySignature(req)) {
    Logger.warn('Meta webhook: signature verification failed');
    res.sendStatus(403);
    return;
  }

  // Respond fast — Meta retries on timeout. Process async.
  res.sendStatus(200);

  try {
    const body = req.body as {
      object?: string;
      entry?: Array<{
        changes?: Array<{
          field?: string;
          value?: { leadgen_id?: string; page_id?: string; form_id?: string; ad_id?: string };
        }>;
      }>;
    };

    const entries = body.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'leadgen') continue;
        const leadId = change.value?.leadgen_id;
        if (!leadId) continue;

        const lead = await fetchLeadFromGraph(leadId);
        if (!lead) continue;

        const phone = extractField(lead, ['phone_number', 'phone']);
        const name =
          extractField(lead, ['full_name', 'name']) ||
          [extractField(lead, ['first_name']), extractField(lead, ['last_name'])]
            .filter(Boolean)
            .join(' ') ||
          null;

        const statusText = 'New lead from Meta';
        const { temperature, source } = await classifier.classify(statusText);

        const doc: LeadEventDocument = {
          date: (lead.created_time ?? new Date().toISOString()).slice(0, 10) || getTodayDate(),
          customer: { name, phone },
          page: lead.page_id ?? null,
          follower: null,
          status_text: statusText,
          temperature,
          temperature_source: source,
          meta_lead_id: leadId,
          meta_sync_status: 'pending',
          source: { telegram_msg_id: `meta-${leadId}`, model: 'meta-webhook' },
          created_at: new Date()
        };

        const insertedId = await repository.saveLeadEvent(doc);
        Logger.info(`Saved Meta lead ${leadId} as event ${insertedId}, temperature=${temperature}`);

        if (doc.temperature) {
          void pushTemperatureEvent({ ...doc, _id: insertedId }, repository);
        }
      }
    }
  } catch (error) {
    Logger.error('Meta webhook processing error', error as Error);
  }
});

export default router;
