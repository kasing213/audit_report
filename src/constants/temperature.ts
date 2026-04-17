export const TEMPERATURES = [
  { value: 'hot', label: 'Hot', labelKm: 'ក្តៅ', emoji: '🔥', chipClass: 'tag-temp-hot' },
  { value: 'warm', label: 'Warm', labelKm: 'ក្លន្តក្លៀវ', emoji: '🌤️', chipClass: 'tag-temp-warm' },
  { value: 'cold', label: 'Cold', labelKm: 'ត្រជាក់', emoji: '❄️', chipClass: 'tag-temp-cold' }
] as const;

export type Temperature = typeof TEMPERATURES[number]['value'];
export type TemperatureSource = 'rules' | 'llm' | 'manual';

export const TEMPERATURE_LABELS: Record<Temperature, string> = TEMPERATURES.reduce((acc, t) => {
  acc[t.value] = t.label;
  return acc;
}, {} as Record<Temperature, string>);

export const TEMPERATURE_EMOJIS: Record<Temperature, string> = TEMPERATURES.reduce((acc, t) => {
  acc[t.value] = t.emoji;
  return acc;
}, {} as Record<Temperature, string>);

export const TEMPERATURE_CHIP_CLASSES: Record<Temperature, string> = TEMPERATURES.reduce((acc, t) => {
  acc[t.value] = t.chipClass;
  return acc;
}, {} as Record<Temperature, string>);

export function isTemperature(value: string): value is Temperature {
  return TEMPERATURES.some((t) => t.value === value);
}

export function parseTemperature(input: string): Temperature | null {
  const normalized = input.trim().toLowerCase();
  return isTemperature(normalized) ? (normalized as Temperature) : null;
}

export function formatTemperatureDisplay(temperature?: string | null): string {
  if (!temperature || !isTemperature(temperature)) return '—';
  return `${TEMPERATURE_EMOJIS[temperature]} ${TEMPERATURE_LABELS[temperature]}`;
}

// Reason codes (A–J) → temperature mapping. Used when a reason code is already assigned,
// giving a more reliable signal than keyword-matching status_text.
// Rationale: interested/ready = hot, still considering = warm, explicit decline = cold.
export const REASON_CODE_TO_TEMPERATURE: Record<string, Temperature> = {
  I: 'warm', // ចាំរកថ្ងៃទំនេរមកមើល — plans to visit
  A: 'cold', // ថ្លៃពេក
  B: 'cold', // ទីតាំងមិនត្រូវ
  C: 'cold', // មិនមែនអ្នកសម្រេច
  D: 'cold', // គ្មានចំណាប់អារម្មណ៍
  E: 'cold', // ត្រូវការកម្ចីច្រើន
  F: 'cold', // ជំពាក់គេច្រើន
  G: 'cold', // ខូច CBC
  H: 'cold', // ដីឬផ្ទះតូចពេក
  J: 'warm'  // ផ្សេងៗ — unclassified, treat as follow-up
};
