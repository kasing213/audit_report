import { Logger } from '../utils/logger';
import { OutreachProposalDocument } from './outreach-repository';

export type AlertKind =
  | 'mark-failed'
  | 'lease-expired'
  | 'worker-offline'
  | 'session-expired'
  | 'worker-fatal';

type SendMessage = (chatId: string, text: string, extra?: any) => Promise<void>;

const PER_PHONE_THROTTLE_MS = 6 * 60 * 60 * 1000; // 6h
const PER_KIND_THROTTLE_MS = 30 * 60 * 1000; // 30m for worker-level alerts
const WORKER_LEVEL_KINDS = new Set<AlertKind>(['worker-offline', 'session-expired', 'worker-fatal']);

let sender: SendMessage | null = null;
const recentAlerts = new Map<string, number>();

export function setOutreachAlertSender(fn: SendMessage | null): void {
  sender = fn;
}

function dedupeKey(kind: AlertKind, phone: string | null): string {
  if (WORKER_LEVEL_KINDS.has(kind)) return `kind:${kind}`;
  return `${kind}:${phone || 'unknown'}`;
}

function shouldThrottle(kind: AlertKind, phone: string | null): boolean {
  const key = dedupeKey(kind, phone);
  const last = recentAlerts.get(key);
  const now = Date.now();
  const window = WORKER_LEVEL_KINDS.has(kind) ? PER_KIND_THROTTLE_MS : PER_PHONE_THROTTLE_MS;
  if (last && now - last < window) return true;
  recentAlerts.set(key, now);
  return false;
}

function buildBaseUrl(): string {
  return process.env.PUBLIC_BASE_URL || process.env.BASE_URL || 'https://auditreport-production.up.railway.app';
}

interface FailureContext {
  reason?: string;
  worker_id?: string;
  details?: string;
}

function formatProposalAlert(
  kind: AlertKind,
  proposal: Pick<OutreachProposalDocument, '_id' | 'customer_name' | 'customer_phone' | 'follower'> | null,
  ctx: FailureContext
): string {
  const lines: string[] = [];
  switch (kind) {
    case 'mark-failed':
      lines.push('🚨 *Outreach send FAILED*');
      break;
    case 'lease-expired':
      lines.push('⚠️ *Outreach lease expired (3rd attempt)*');
      break;
    case 'worker-offline':
      lines.push('⚠️ *Outreach worker is offline*');
      break;
    case 'session-expired':
      lines.push('🚨 *Outreach worker session expired*');
      break;
    case 'worker-fatal':
      lines.push('🚨 *Outreach worker fatal error*');
      break;
  }

  if (proposal) {
    lines.push('');
    lines.push(`Customer: ${proposal.customer_name || 'Unknown'}`);
    lines.push(`Phone: ${proposal.customer_phone}`);
    if (proposal.follower) lines.push(`Follower: ${proposal.follower}`);
    if (ctx.reason) lines.push(`Reason: ${ctx.reason}`);
    const id = proposal._id ? proposal._id.toString() : null;
    if (id) {
      lines.push('');
      lines.push(`${buildBaseUrl()}/crm/outreach?focus=${id}`);
    }
  } else {
    if (ctx.reason) {
      lines.push('');
      lines.push(`Reason: ${ctx.reason}`);
    }
    if (ctx.worker_id) lines.push(`Worker: ${ctx.worker_id}`);
    lines.push('');
    lines.push(`${buildBaseUrl()}/crm/outreach`);
  }

  return lines.join('\n');
}

export async function notifyOutreachFailure(
  proposal: Pick<OutreachProposalDocument, '_id' | 'customer_name' | 'customer_phone' | 'follower'> | null,
  kind: AlertKind,
  ctx: FailureContext = {}
): Promise<void> {
  const phone = proposal?.customer_phone ?? null;
  if (shouldThrottle(kind, phone)) {
    Logger.info(`outreach-alerts: throttled ${kind} for ${phone || 'worker'}`);
    return;
  }

  const send = sender;
  if (!send) {
    Logger.warn(`outreach-alerts: no sender registered, dropping ${kind} for ${phone || 'worker'}`);
    return;
  }

  const chatId = process.env.AUDIT_CHAT_ID || process.env.REPORT_CHAT_ID;
  if (!chatId) {
    Logger.warn('outreach-alerts: AUDIT_CHAT_ID not set, dropping alert');
    return;
  }

  const text = formatProposalAlert(kind, proposal, ctx);
  try {
    await send(chatId, text, { parse_mode: 'Markdown' });
    Logger.info(`outreach-alerts: sent ${kind} for ${phone || 'worker'}`);
  } catch (err) {
    Logger.error('outreach-alerts: send failed', err as Error);
  }
}
