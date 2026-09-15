/**
 * Convert values returned by RSS/AI providers into safe human-readable text.
 *
 * rss-parser represents namespaced RSS elements such as NYT categories as
 * objects like { _: 'Politics', $: { domain: '...' } }. Stringifying those
 * objects directly creates the literal feature "[object Object]", which can
 * poison preference learning.
 */
export function coerceText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  if (!value || typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  for (const key of ['_', '#text', 'term', 'name', 'label', 'value']) {
    const candidate = record[key];
    if (typeof candidate === 'string') {
      const text = candidate.trim();
      if (text) return text;
    }
  }

  return '';
}

export function normalizeTextArray(value: unknown, limit = 20): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const result: string[] = [];
  const seen = new Set<string>();

  for (const item of values) {
    const text = coerceText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }

  return result;
}

export function parseJsonTextArray(
  value: string | null | undefined,
  limit = 20,
): string[] {
  if (!value) return [];
  try {
    return normalizeTextArray(JSON.parse(value), limit);
  } catch {
    return [];
  }
}
