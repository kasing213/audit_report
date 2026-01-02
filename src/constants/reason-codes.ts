export const REASON_CODES = [
  { code: 'A', label: 'ថ្លៃពេក' },
  { code: 'B', label: 'ទីតាំងមិនត្រូវ' },
  { code: 'C', label: 'មិនមែនអ្នកសម្រេច' },
  { code: 'D', label: 'គ្មានចំណាប់អារម្មណ៍' },
  { code: 'E', label: 'ត្រូវការកម្ចីច្រើន' },
  { code: 'F', label: 'ជំពាក់គេច្រើន' },
  { code: 'G', label: 'ខូច CBC' },
  { code: 'H', label: 'ដីឬផ្ទះតូចពេក' },
  { code: 'I', label: 'ចាំរកថ្ងៃទំនេរមកមើល' },
  { code: 'J', label: 'ផ្សេងៗ' }
] as const;

export type ReasonCode = typeof REASON_CODES[number]['code'];

export const REASON_CODE_LABELS: Record<ReasonCode, string> = REASON_CODES.reduce((acc, item) => {
  acc[item.code] = item.label;
  return acc;
}, {} as Record<ReasonCode, string>);

export const REASON_PROMPT_HEADER = 'សូមជ្រើសរើសហេតុផលឆ្លើយតបរបស់ភ្ញៀវ (ជ្រើសរើសតែមួយ):';
export const REASON_PROMPT_FOOTER = 'សូមបញ្ចូលតែអក្សរ A–J';

export function buildReasonPrompt(): string {
  const lines = REASON_CODES.map((item) => `${item.code} - ${item.label}`);
  return [REASON_PROMPT_HEADER, '', ...lines, '', REASON_PROMPT_FOOTER].join('\n');
}

export function buildReasonKeyboardRows(): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < REASON_CODES.length; i += 2) {
    const left = `${REASON_CODES[i].code} - ${REASON_CODES[i].label}`;
    const right = REASON_CODES[i + 1] ? `${REASON_CODES[i + 1].code} - ${REASON_CODES[i + 1].label}` : null;
    rows.push(right ? [left, right] : [left]);
  }
  return rows;
}

export function isReasonCode(value: string): value is ReasonCode {
  return Object.prototype.hasOwnProperty.call(REASON_CODE_LABELS, value);
}

export function parseReasonCode(input: string): ReasonCode | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const letterMatch = trimmed.match(/^[A-J]$/i);
  if (letterMatch) {
    return letterMatch[0].toUpperCase() as ReasonCode;
  }

  for (const item of REASON_CODES) {
    const fullLabel = `${item.code} - ${item.label}`;
    if (trimmed === fullLabel) {
      return item.code;
    }
  }

  return null;
}

export function formatReasonDisplay(reasonCode?: string | null, statusText?: string | null): string {
  if (reasonCode && isReasonCode(reasonCode)) {
    return `${reasonCode} - ${REASON_CODE_LABELS[reasonCode]}`;
  }

  if (statusText) {
    return statusText;
  }

  return 'N/A';
}
