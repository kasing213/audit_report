/**
 * Payment reminder wording: the supported placeholder set, its validation, and
 * deterministic rendering.
 *
 * Not Handlebars. Every value substituted here comes from a validated source
 * receivable, and the whole point is that nothing else can. A free-form
 * template engine would happily render an expression, a helper, or an undefined
 * value as empty — in a message about money owed, that is exactly the failure
 * mode to prevent. So the placeholder set is closed, unknown placeholders are
 * rejected at approval time, and an empty substitution throws rather than
 * silently producing "you owe  by ".
 */
import { PaymentGroup } from './payment-types';

/** The complete set of placeholders payment wording may use. */
export const SUPPORTED_PLACEHOLDERS = [
  'customer_name',
  'customer_names',
  'ar_references',
  'home_references',
  'amount_due',
  'currency',
  'due_date',
] as const;

export type PaymentPlaceholder = (typeof SUPPORTED_PLACEHOLDERS)[number];

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export class PaymentTemplateError extends Error {}

/**
 * Reject wording that references anything outside the supported set. Runs at
 * save/approve time so a bad placeholder is caught by a human action rather
 * than by a scan at 10:00.
 */
export function assertSupportedPlaceholders(text: string): void {
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (!SUPPORTED_PLACEHOLDERS.includes(name as PaymentPlaceholder)) {
      throw new PaymentTemplateError(`unsupported placeholder: ${name}`);
    }
  }
}

/**
 * Format money as the exact numeric value, ungrouped. No currency conversion,
 * no rounding, no thousands separator — the number rendered is the number that
 * was validated, so the message can be reconciled against the source.
 */
function formatAmount(value: number): string {
  return String(value);
}

/**
 * Substitute a group's validated fields into approved wording.
 *
 * Lists keep ar_id order from the domain layer rather than being re-sorted
 * here, so the same group always renders the same message.
 */
export function renderPaymentTemplate(text: string, group: PaymentGroup): string {
  const values: Record<PaymentPlaceholder, string> = {
    customer_name: group.customerNames[0] ?? '',
    customer_names: group.customerNames.join(' / '),
    ar_references: group.arIds.join(', '),
    home_references: group.homeReferences.join(', '),
    amount_due: formatAmount(group.balanceDue),
    currency: group.currency,
    due_date: group.dueDate,
  };

  return text.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
    if (!SUPPORTED_PLACEHOLDERS.includes(name as PaymentPlaceholder)) {
      throw new PaymentTemplateError(`unsupported placeholder: ${name}`);
    }
    const value = values[name as PaymentPlaceholder];
    if (value.length === 0) {
      // Blocking the draft is the safe outcome: a reminder with a blank name or
      // a blank amount is worse than no reminder.
      throw new PaymentTemplateError(`no source value for placeholder: ${name}`);
    }
    return value;
  });
}
