export const DESTINATION_OPTIONS = [
  { key: 'telegram', label: 'Telegram' },
  { key: 'messenger', label: 'Messenger' },
  { key: 'walkin', label: 'មកផ្ទាល់ (Walk-in)' },
  { key: 'call', label: 'ទូរស័ព្ទ (Call)' },
  { key: 'line', label: 'Line' },
  { key: 'other', label: 'ផ្សេងៗ (Other)' }
] as const;

export function buildDestinationKeyboardRows(): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < DESTINATION_OPTIONS.length; i += 2) {
    const left = DESTINATION_OPTIONS[i].label;
    const right = DESTINATION_OPTIONS[i + 1] ? DESTINATION_OPTIONS[i + 1].label : null;
    rows.push(right ? [left, right] : [left]);
  }
  return rows;
}

export function parseDestination(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Exact match on label
  const found = DESTINATION_OPTIONS.find(d => d.label === trimmed || d.key === trimmed.toLowerCase());
  if (found) return found.label;

  // Partial match (case-insensitive)
  const lower = trimmed.toLowerCase();
  const partial = DESTINATION_OPTIONS.find(d =>
    d.label.toLowerCase().includes(lower) || d.key.includes(lower)
  );
  if (partial) return partial.label;

  // Accept free text as-is
  return trimmed;
}
