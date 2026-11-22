import type { PageServerLoad } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import { getDecayedStrength } from '#lib/server/preferences.ts';

type PreferenceMemoryRow = {
  id: string;
  label: string;
  type: string;
  polarity: 'positive' | 'negative';
  strength: number;
  evidence_count: number;
  last_reinforced: number;
  explanation: string;
  created_at: number;
};

const SPECIAL_TOKENS: Record<string, string> = {
  c_plus_plus: 'C++',
  c_sharp: 'C#',
  f_sharp: 'F#',
  dotnet: '.NET',
  nodejs: 'Node.js',
  ai: 'AI',
  llm: 'LLM',
  llms: 'LLMs',
  api: 'API',
  apis: 'APIs',
  sql: 'SQL',
  css: 'CSS',
  html: 'HTML',
  rss: 'RSS',
  seo: 'SEO',
  ui: 'UI',
  ux: 'UX',
};

function formatWord(word: string): string {
  const lower = word.toLowerCase();
  if (SPECIAL_TOKENS[lower]) return SPECIAL_TOKENS[lower];
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function _formatPreferenceLabel(rawLabel: string, type = ''): string {
  const trimmed = (rawLabel || '').trim();
  if (!trimmed) return 'Unnamed preference';

  const stripped = trimmed.replace(
    /^(?:phrase|topic|entity|author|signal|content_type|negative_filter|feed):/i,
    '',
  );
  if (!stripped) return trimmed;

  const restoreSpecial = (input: string) =>
    input
      .replace(/\bc_plus_plus\b/gi, 'c_plus_plus')
      .replace(/\bc_sharp\b/gi, 'c_sharp')
      .replace(/\bf_sharp\b/gi, 'f_sharp');

  const isPhrase =
    type === 'phrase' || /^phrase:/i.test(trimmed) || stripped.includes(':');
  if (isPhrase && stripped.includes(':')) {
    const parts = stripped
      .split(':')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) =>
        restoreSpecial(part)
          .split(/[\s-]+/)
          .filter(Boolean)
          .map(formatWord)
          .join(' '),
      );
    if (parts.length > 0) return parts.join(' · ');
  }

  if (SPECIAL_TOKENS[stripped.toLowerCase()]) {
    return SPECIAL_TOKENS[stripped.toLowerCase()];
  }

  const words = restoreSpecial(stripped)
    .split(/(?<!c_plus|c|f)_(?!plus|sharp)|[:\s-]+/)
    .filter(Boolean)
    .map(formatWord);

  return words.length > 0 ? words.join(' ') : stripped;
}

export function _formatPreferenceType(
  type: string,
  polarity?: 'positive' | 'negative',
): string {
  const normalized = (type || '').trim().toLowerCase();
  switch (normalized) {
    case 'topic':
      return 'Topic';
    case 'entity':
      return 'Entity';
    case 'author':
      return 'Author';
    case 'signal':
      return 'Quality Signal';
    case 'content_type':
      return 'Content Type';
    case 'negative_filter':
      return polarity === 'positive'
        ? 'Content Filter (Allowed)'
        : 'Content Filter';
    case 'phrase':
      return 'Title Phrase';
    default:
      return (
        normalized
          .split(/[_\s-]+/)
          .filter(Boolean)
          .map(formatWord)
          .join(' ') || 'Preference'
      );
  }
}

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) return {};
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM user_preference_memory')
    .all() as PreferenceMemoryRow[];
  const preferences = rows
    .map((row) => ({
      ...row,
      strength: getDecayedStrength(
        Number(row.strength || 0),
        Number(row.last_reinforced || 0),
      ),
      displayLabel: _formatPreferenceLabel(row.label, row.type),
      displayType: _formatPreferenceType(row.type, row.polarity),
    }))
    .sort((a, b) => b.strength - a.strength);
  return { preferences };
};
