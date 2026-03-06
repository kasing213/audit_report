import { Markup } from 'telegraf';

const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const inlineTimestamps = new Map<string, number>();

export function buildInlineButtons(eventId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✏️ កែ (Edit)', `edit:${eventId}`),
      Markup.button.callback('🗑️ លុប (Delete)', `delete:${eventId}`)
    ]
  ]);
}

export function registerInlineTimestamp(eventId: string): void {
  inlineTimestamps.set(eventId, Date.now());
}

export function isInlineExpired(eventId: string): boolean {
  const timestamp = inlineTimestamps.get(eventId);
  if (!timestamp) return true;
  if (Date.now() - timestamp > EXPIRY_MS) {
    inlineTimestamps.delete(eventId);
    return true;
  }
  return false;
}
