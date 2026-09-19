const PHNOM_PENH_TIME_ZONE = 'Asia/Phnom_Penh';
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: PHNOM_PENH_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Convert a source instant to the calendar date used by Lead Control. */
export function phnomPenhBusinessDate(value: Date | null): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  const parts = formatter.formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
