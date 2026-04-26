import { CustomerCase } from '../database/models';
import { toInternationalPhone } from '../utils/phone-utils';
import { DraftResult, ReviewResult } from './openai-drafter';

const KHMER_RANGE = /[ក-៿]/g;
const EMOJI_RANGE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const URL_PATTERN = /(https?:\/\/|www\.|\.com|\.kh)/i;
const PHONE_E164 = /^\+855\d{8,9}$/;

const BANNED_TOKENS = [
  'discount',
  'promo',
  'urgent',
  'limited',
  '!!',
  'OPENAI',
  'gpt-',
  'As an AI',
  'assistant:',
  'system:',
];

const MIN_LEN = 40;
const MAX_LEN = 320;
const MIN_KHMER_CHARS = 8;
const MIN_DAYS_SINCE_LAST_CONTACT = 14;

export interface AutoApproveDecision {
  ok: boolean;
  reason: string;
}

function daysSince(dateString: string | null | undefined): number | null {
  if (!dateString) return null;
  const parsed = new Date(dateString).getTime();
  if (Number.isNaN(parsed)) return null;
  return Math.floor((Date.now() - parsed) / (1000 * 60 * 60 * 24));
}

function blocklist(): Set<string> {
  const raw = process.env.OUTREACH_PHONE_BLOCKLIST || '';
  return new Set(
    raw.split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => toInternationalPhone(p))
  );
}

export function isAutoApproveEnabled(): boolean {
  return process.env.OUTREACH_AUTO_APPROVE === 'true';
}

/**
 * Decide whether a reviewer-approved draft can bypass human review.
 *
 * All ten rules must pass. Borderline drafts fall back to `pending` so a human
 * still sees them. This function is pure (no I/O, no DB) so it is trivial to
 * unit-test and trivial to flip off via the env flag.
 */
export function canAutoApprove(
  draft: DraftResult,
  customer: CustomerCase,
  review: ReviewResult
): AutoApproveDecision {
  if (!review.approve) return { ok: false, reason: 'reviewer did not approve' };
  if (!review.reason || review.reason.length === 0) return { ok: false, reason: 'reviewer reason empty' };

  const message = draft.message;
  if (message.length < MIN_LEN || message.length > MAX_LEN) {
    return { ok: false, reason: `message length ${message.length} outside [${MIN_LEN}, ${MAX_LEN}]` };
  }

  const khmerMatches = message.match(KHMER_RANGE);
  if (!khmerMatches || khmerMatches.length < MIN_KHMER_CHARS) {
    return { ok: false, reason: 'too few Khmer codepoints' };
  }

  if (!customer.phone) return { ok: false, reason: 'customer has no phone' };
  const intl = toInternationalPhone(customer.phone.trim());
  if (!PHONE_E164.test(intl)) return { ok: false, reason: `phone ${intl} not Cambodian E.164` };
  if (blocklist().has(intl)) return { ok: false, reason: 'phone is on OUTREACH_PHONE_BLOCKLIST' };

  const lower = message.toLowerCase();
  for (const token of BANNED_TOKENS) {
    if (lower.includes(token.toLowerCase())) {
      return { ok: false, reason: `banned token: ${token}` };
    }
  }
  if (EMOJI_RANGE.test(message)) return { ok: false, reason: 'message contains emoji' };
  if (URL_PATTERN.test(message)) return { ok: false, reason: 'message contains URL-like pattern' };

  // Defend against the model echoing the customer phone back to them.
  const phoneDigits = intl.replace(/\D/g, '');
  if (phoneDigits.length >= 8 && message.replace(/\D/g, '').includes(phoneDigits.slice(-8))) {
    return { ok: false, reason: 'message echoes customer phone digits' };
  }

  if (customer.current_temperature === 'cold' && (customer.total_events ?? 0) < 2) {
    return { ok: false, reason: 'single-touch cold lead — too risky to auto-send' };
  }

  const days = daysSince(customer.last_update_date);
  if (days !== null && days < MIN_DAYS_SINCE_LAST_CONTACT) {
    return { ok: false, reason: `last contact only ${days}d ago` };
  }

  if (!draft.model.startsWith('gpt-')) {
    return { ok: false, reason: `unexpected model ${draft.model}` };
  }

  return { ok: true, reason: 'all gates passed' };
}
