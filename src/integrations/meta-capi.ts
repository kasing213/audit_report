import { createHash } from 'crypto';
import { LeadEventDocument } from '../database/models';
import { SalesCaseRepository } from '../database/repository';
import { Logger } from '../utils/logger';
import { Temperature } from '../constants/temperature';

const GRAPH_API_VERSION = 'v19.0';
const REQUEST_TIMEOUT_MS = 10_000;

const EVENT_NAME_BY_TEMPERATURE: Record<Temperature, string> = {
  hot: 'HotLead',
  warm: 'WarmLead',
  cold: 'ColdLead'
};

function sha256Lower(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

function normalizePhoneForHash(phone: string): string {
  // Meta expects E.164 digits without leading + or spaces
  return phone.replace(/[^\d]/g, '');
}

/**
 * Push a temperature change to Meta as a CAPI custom event keyed by meta_lead_id.
 * Silently no-ops when required env vars or doc fields are missing — must never
 * throw into the Telegram handler.
 */
export async function pushTemperatureEvent(
  doc: LeadEventDocument,
  repository: SalesCaseRepository
): Promise<void> {
  if (!doc.meta_lead_id || !doc.temperature) return;

  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_CAPI_TOKEN;
  if (!pixelId || !accessToken) {
    Logger.warn('Meta CAPI env vars missing — skipping temperature push');
    return;
  }

  const userData: Record<string, string> = {};
  if (doc.customer?.phone) {
    userData.ph = sha256Lower(normalizePhoneForHash(doc.customer.phone));
  }
  if (doc.customer?.name) {
    userData.fn = sha256Lower(doc.customer.name);
  }

  const payload = {
    data: [
      {
        event_name: EVENT_NAME_BY_TEMPERATURE[doc.temperature],
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'system_generated',
        custom_data: { lead_id: doc.meta_lead_id },
        user_data: userData
      }
    ]
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let success = false;
  try {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.text();
      Logger.error(`Meta CAPI non-2xx (${response.status}): ${body.substring(0, 200)}`);
    } else {
      success = true;
    }
  } catch (error) {
    Logger.error('Meta CAPI request failed', error as Error);
  } finally {
    clearTimeout(timeoutId);
  }

  if (doc._id) {
    try {
      await repository.updateLeadEvent(doc._id, {
        meta_sync_status: success ? 'synced' : 'failed'
      });
    } catch (error) {
      Logger.error('Failed to update meta_sync_status', error as Error);
    }
  }
}
