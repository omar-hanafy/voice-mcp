/** Collapse all whitespace (including newlines) to single spaces and trim. */
export function normalizeSpeakText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim();
}

/** One-line preview no longer than `maxLength` characters (ellipsis included). */
export function previewText(raw: string, maxLength: number): string {
  const max = Math.floor(maxLength);
  if (max <= 0) return '';
  const text = normalizeSpeakText(raw);
  if (text.length <= max) return text;
  if (max === 1) return text.slice(0, 1);
  return `${text.slice(0, max - 1)}…`;
}
