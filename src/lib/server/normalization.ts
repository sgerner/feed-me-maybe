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

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '…',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  rdquo: '”',
  rsquo: '’',
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower in NAMED_HTML_ENTITIES) return NAMED_HTML_ENTITIES[lower];
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return match;
  });
}

export function stripHtml(value: string): string {
  const withoutTags = decodeHtmlEntities(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[a-z!][^>]*>/gi, ' ');
  return decodeHtmlEntities(withoutTags).replace(/\s+/g, ' ').trim();
}
