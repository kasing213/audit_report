/**
 * Convert a local Cambodian phone number to international format.
 * e.g. "093724678" → "+85593724678", "0712345678" → "+855712345678"
 * If already has +855 prefix, returns as-is.
 */
export function toInternationalPhone(phone: string): string {
  const cleaned = phone.replace(/[\s\-()]/g, '');

  if (cleaned.startsWith('+855')) {
    return cleaned;
  }

  if (cleaned.startsWith('855') && cleaned.length > 9) {
    return `+${cleaned}`;
  }

  if (cleaned.startsWith('0')) {
    return `+855${cleaned.slice(1)}`;
  }

  // Assume it's already without leading 0
  return `+855${cleaned}`;
}

/**
 * Generate a clickable Telegram link from a phone number.
 * e.g. "093724678" → "https://t.me/+85593724678"
 */
export function formatTelegramLink(phone: string): string {
  const international = toInternationalPhone(phone);
  return `https://t.me/${international}`;
}

/**
 * Format phone for display with spaces.
 * e.g. "093724678" → "+855 93 724 678"
 */
export function formatPhoneDisplay(phone: string): string {
  const international = toInternationalPhone(phone);
  // +855 XX XXX XXXX or +855 XX XXX XXX
  const digits = international.replace('+855', '');
  if (digits.length === 8) {
    return `+855 ${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`;
  }
  if (digits.length === 9) {
    return `+855 ${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`;
  }
  return international;
}
