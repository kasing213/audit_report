import { Logger } from '../utils/logger';

type SendMessage = (chatId: string, text: string, extra?: any) => Promise<void>;

interface ReplyContext {
  name: string | null;
  phone: string;
  text: string;
  follower: string | null;
}

let sender: SendMessage | null = null;

export function setInboundAlertSender(fn: SendMessage | null): void {
  sender = fn;
}

function buildBaseUrl(): string {
  return process.env.PUBLIC_BASE_URL || process.env.BASE_URL || 'https://auditreport-production.up.railway.app';
}

function escapeMarkdown(s: string): string {
  return s.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function formatInboundReply(ctx: ReplyContext): string {
  const lines: string[] = [];
  lines.push('📥 *New customer reply*');
  lines.push('');
  lines.push(`From: ${escapeMarkdown(ctx.name || 'Unknown')} (${escapeMarkdown(ctx.phone)})`);
  lines.push(`Follower: ${ctx.follower ? escapeMarkdown(ctx.follower) : '—'}`);
  lines.push('');
  lines.push(escapeMarkdown(ctx.text));
  lines.push('');
  lines.push(`${buildBaseUrl()}/crm?phone=${encodeURIComponent(ctx.phone)}`);
  return lines.join('\n');
}

export async function notifyInboundReply(chatId: string, ctx: ReplyContext): Promise<boolean> {
  const send = sender;
  if (!send) {
    Logger.warn(`inbound-alerts: no sender registered, dropping reply from ${ctx.phone}`);
    return false;
  }
  const text = formatInboundReply(ctx);
  try {
    await send(chatId, text, { parse_mode: 'MarkdownV2' });
    Logger.info(`inbound-alerts: sent reply notification for ${ctx.phone}`);
    return true;
  } catch (err) {
    Logger.error('inbound-alerts: send failed', err as Error);
    return false;
  }
}
