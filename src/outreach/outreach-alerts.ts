import { Logger } from '../utils/logger';
import { OutreachProposalDocument } from './outreach-repository';

export type AlertKind =
  | 'mark-failed'
  | 'transient-requeue'
  | 'lease-expired'
  | 'worker-offline'
  | 'session-expired'
  | 'worker-fatal'
  | 'daily-cap-reached';

type SendMessage = (chatId: string, text: string, extra?: any) => Promise<void>;

const PER_PHONE_THROTTLE_MS = 6 * 60 * 60 * 1000; // 6h
const PER_KIND_THROTTLE_MS = 30 * 60 * 1000; // 30m for worker-level alerts
const WORKER_LEVEL_KINDS = new Set<AlertKind>(['worker-offline', 'session-expired', 'worker-fatal', 'daily-cap-reached']);

let sender: SendMessage | null = null;
const recentAlerts = new Map<string, number>();

export function setOutreachAlertSender(fn: SendMessage | null): void {
  sender = fn;
}

function dedupeKey(kind: AlertKind, phone: string | null, org?: string): string {
  // Worker-level alerts throttle per (kind, org) so a company-offline alert
  // doesn't suppress a personal-offline one (and vice versa).
  if (WORKER_LEVEL_KINDS.has(kind)) return `kind:${kind}:${org || 'default'}`;
  return `${kind}:${phone || 'unknown'}`;
}

function shouldThrottle(kind: AlertKind, phone: string | null, org?: string): boolean {
  const key = dedupeKey(kind, phone, org);
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
  // Override the destination chat. Defaults to AUDIT_CHAT_ID. The heartbeat
  // watchdog uses this to DM the operator directly instead of the audit group.
  chatId?: string;
  // Which outreach workspace this alert is about ('company' | 'personal'). Used
  // to label worker-level alerts and to throttle them per org.
  org?: string;
}

function formatProposalAlert(
  kind: AlertKind,
  proposal: Pick<OutreachProposalDocument, '_id' | 'customer_name' | 'customer_phone' | 'follower'> | null,
  ctx: FailureContext
): string {
  const lines: string[] = [];
  const orgTag = ctx.org ? ` (${ctx.org})` : '';
  switch (kind) {
    case 'mark-failed':
      lines.push('🚨 *Outreach send FAILED*');
      break;
    case 'transient-requeue':
      lines.push('🔁 *Outreach send failed transiently — re-queued*');
      break;
    case 'lease-expired':
      lines.push('⚠️ *Outreach lease expired (3rd attempt)*');
      break;
    case 'worker-offline':
      lines.push(`⚠️ *Outreach worker is offline*${orgTag}`);
      break;
    case 'session-expired':
      lines.push(`🚨 *Outreach worker session expired*${orgTag}`);
      break;
    case 'worker-fatal':
      lines.push(`🚨 *Outreach worker fatal error*${orgTag}`);
      break;
    case 'daily-cap-reached': {
      lines.push(`✅ *Outreach delivery cap reached*${orgTag}`);
      lines.push('');
      lines.push(`Delivered: ${ctx.reason || 'cap reached'} today.`);
      lines.push('Resumes after UTC midnight reset.');
      return lines.join('\n');
    }
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
  if (shouldThrottle(kind, phone, ctx.org)) {
    Logger.info(`outreach-alerts: throttled ${kind} for ${phone || 'worker'}`);
    return;
  }

  const send = sender;
  if (!send) {
    Logger.warn(`outreach-alerts: no sender registered, dropping ${kind} for ${phone || 'worker'}`);
    return;
  }

  const chatId = ctx.chatId || process.env.AUDIT_CHAT_ID || process.env.REPORT_CHAT_ID;
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
