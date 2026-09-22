import fs from 'node:fs';
import { getDb } from '$lib/server/db';
import { parseJsonTextArray } from '$lib/server/normalization';
import { refreshCombinedScore } from '$lib/server/scoring';

const JEV_ENDPOINT =
  process.env.TYPESAFE_API_URL ||
  process.env.JEV_API_URL ||
  'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const PREFERENCE_HALF_LIFE_DAYS = 45;

type ArticleJevRow = {
  title: string | null;
  summary: string | null;
  content: string | null;
  author: string | null;
  categories: string | null;
  published_at: number | null;
  fetched_at: number;
  feed_title: string | null;
  feed_category: string | null;
  ai_summary: string | null;
  ai_topics: string | null;
  ai_entities: string | null;
  ai_content_type: string | null;
  ai_signals: string | null;
};

type PreferenceRow = {
  type: string;
  label: string;
  polarity: string;
  strength: number;
  evidence_count: number;
  last_reinforced: number;
};

function compactText(value: unknown, limit: number): string {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function readApiKey(): string {
  const direct = (
    process.env.TYPESAFE_API_KEY ||
    process.env.JEV_API_KEY ||
    ''
  ).trim();
  if (direct) return direct;

  const paths = [
    process.env.TYPESAFE_API_KEY_FILE,
    process.env.JEV_API_KEY_FILE,
    '/run/secrets/typesafe_api_key',
    '/run/secrets/jev_api_key',
  ].filter((value): value is string => Boolean(value));

  for (const filePath of paths) {
    try {
      const value = fs.readFileSync(filePath, 'utf8').trim();
      if (value) return value;
    } catch {
      // The secret is optional in local development.
    }
  }
  return '';
}

export function isJevConfigured(): boolean {
  return Boolean(readApiKey());
}

function decayedStrength(strength: number, lastReinforced: number): number {
  const ageDays = Math.max(
    0,
    (Date.now() - Number(lastReinforced || 0)) / (24 * 60 * 60 * 1000),
  );
  return Math.max(
    0,
    Math.min(
      1,
      Number(strength || 0) *
        Math.pow(0.5, ageDays / PREFERENCE_HALF_LIFE_DAYS),
    ),
  );
}

function getReaderProfile(): Record<string, unknown> {
  const db = getDb();
  const rows = db
    .prepare(
      `
        SELECT type, label, polarity, strength, evidence_count, last_reinforced
        FROM user_preference_memory
        WHERE evidence_count > 0
        ORDER BY evidence_count DESC, last_reinforced DESC
        LIMIT 250
      `,
    )
    .all() as PreferenceRow[];

  const grouped = new Map<
    string,
    {
      type: string;
      label: string;
      positive: number;
      negative: number;
      evidenceCount: number;
    }
  >();

  for (const row of rows) {
    const type = compactText(row.type, 40);
    const label = compactText(row.label, 120);
    if (!type || !label) continue;
    const key = `${type}|${label}`;
    const current = grouped.get(key) || {
      type,
      label,
      positive: 0,
      negative: 0,
      evidenceCount: 0,
    };
    const weighted =
      decayedStrength(row.strength, row.last_reinforced) *
      (1 + Math.log1p(Math.max(0, Number(row.evidence_count || 0))));
    if (row.polarity === 'negative') current.negative += weighted;
    else current.positive += weighted;
    current.evidenceCount += Number(row.evidence_count || 0);
    grouped.set(key, current);
  }

  const preferences = [...grouped.values()]
    .map((item) => ({
      ...item,
      net: item.positive - item.negative,
    }))
    .filter((item) => Math.abs(item.net) >= 0.08);

  const formatPreference = (item: (typeof preferences)[number]) => ({
    type: item.type,
    value: item.label,
    strength: Number(Math.min(1, Math.abs(item.net)).toFixed(3)),
    evidence_count: item.evidenceCount,
  });

  const positivePreferences = preferences
    .filter((item) => item.net > 0)
    .sort((a, b) => b.net - a.net)
    .slice(0, 14)
    .map(formatPreference);
  const negativePreferences = preferences
    .filter((item) => item.net < 0)
    .sort((a, b) => a.net - b.net)
    .slice(0, 14)
    .map(formatPreference);

  const sourceRows = db
    .prepare(
      `
        SELECT COALESCE(NULLIF(f.title, ''), f.url) AS source,
               COUNT(*) AS interaction_count
        FROM user_interactions ui
        JOIN articles a ON a.id = ui.article_id
        JOIN feeds f ON f.id = a.feed_id
        WHERE ui.interaction_type IN ('open', 'read')
        GROUP BY f.id
        ORDER BY interaction_count DESC
        LIMIT 5
      `,
    )
    .all() as Array<{ source: string; interaction_count: number }>;
  const avoidedSourceRows = db
    .prepare(
      `
        SELECT COALESCE(NULLIF(f.title, ''), f.url) AS source,
               COUNT(*) AS interaction_count
        FROM user_interactions ui
        JOIN articles a ON a.id = ui.article_id
        JOIN feeds f ON f.id = a.feed_id
        WHERE ui.interaction_type IN ('thumbs_down', 'hide')
        GROUP BY f.id
        ORDER BY interaction_count DESC
        LIMIT 5
      `,
    )
    .all() as Array<{ source: string; interaction_count: number }>;

  return {
    positive_preferences: positivePreferences,
    negative_preferences: negativePreferences,
    preferred_sources: sourceRows.map((row) => ({
      source: compactText(row.source, 100),
      interactions: Number(row.interaction_count || 0),
    })),
    avoided_sources: avoidedSourceRows.map((row) => ({
      source: compactText(row.source, 100),
      interactions: Number(row.interaction_count || 0),
    })),
  };
}

function getArticle(articleId: string): ArticleJevRow | undefined {
  return getDb()
    .prepare(
      `
        SELECT a.title, a.summary, a.content, a.author, a.categories,
               a.published_at, a.fetched_at,
               f.title AS feed_title, f.category AS feed_category,
               am.summary AS ai_summary, am.topics AS ai_topics,
               am.entities AS ai_entities, am.content_type AS ai_content_type,
               am.signals AS ai_signals
        FROM articles a
        JOIN feeds f ON f.id = a.feed_id
        LEFT JOIN article_ai_metadata am ON am.article_id = a.id
        WHERE a.id = ?
      `,
    )
    .get(articleId) as ArticleJevRow | undefined;
}

function buildState(article: ArticleJevRow): Record<string, unknown> {
  const publishedAt = Number(article.published_at || article.fetched_at || 0);
  const ageHours = publishedAt
    ? Math.max(0, (Date.now() - publishedAt) / (60 * 60 * 1000))
    : null;
  const categories = parseJsonTextArray(article.categories, 8);
  const topics = parseJsonTextArray(article.ai_topics, 8);
  const entities = parseJsonTextArray(article.ai_entities, 8);
  const signals = parseJsonTextArray(article.ai_signals, 8);

  return {
    reader_profile: getReaderProfile(),
    candidate: {
      title: compactText(article.title, 240),
      author: compactText(article.author, 120),
      source: compactText(article.feed_title, 120),
      source_category: compactText(article.feed_category, 80),
      summary: compactText(article.ai_summary || article.summary, 1400),
      content_excerpt: compactText(article.content, 2200),
      categories,
      topics,
      entities,
      content_type: compactText(article.ai_content_type, 50),
      signals,
      age_hours: ageHours == null ? null : Number(ageHours.toFixed(1)),
    },
  };
}

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Unknown Jev error'
  );
}

async function requestJevScore(
  state: Record<string, unknown>,
  apiKey: string,
): Promise<number> {
  const response = await fetch(JEV_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      state,
      model: JEV_MODEL,
      questions: {
        would_open: {
          type: 'noul',
          instructions:
            'Would this reader choose to open this candidate article next? Judge personalized reading relevance, not generic quality. Do not reward title keyword overlap alone. A high value means the article is likely worth opening in this feed today.',
          criteria: {
            true: 'The candidate is a strong match for this reader and is likely worth opening next.',
            false:
              'The candidate is not a strong match for this reader, even if it is generally well written or newsworthy.',
          },
        },
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300).replace(/\s+/g, ' ');
    throw new Error(
      `TypeSafe API returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }

  const data = (await response.json()) as {
    answers?: { would_open?: { noul?: unknown } };
  };
  const score = Number(data.answers?.would_open?.noul);
  if (!Number.isFinite(score)) {
    throw new Error('TypeSafe API returned no usable would_open score');
  }
  return Math.max(0, Math.min(1, score));
}

/** Score one article with Jev and activate it in the stored ranking score. */
export async function scoreArticleWithJev(
  articleId: string,
): Promise<number | null> {
  const apiKey = readApiKey();
  if (!apiKey) return null;

  const article = getArticle(articleId);
  if (!article) return null;

  const db = getDb();
  try {
    const score = await requestJevScore(buildState(article), apiKey);
    db.prepare(
      `
        UPDATE articles
        SET jev_score = ?, jev_processed_at = ?, jev_error = ''
        WHERE id = ?
      `,
    ).run(score, Date.now(), articleId);
    refreshCombinedScore(articleId);
    return score;
  } catch (error) {
    const message = truncateError(error);
    db.prepare(
      'UPDATE articles SET jev_processed_at = ?, jev_error = ? WHERE id = ?',
    ).run(Date.now(), message, articleId);
    throw new Error(`Jev scoring failed for ${articleId}: ${message}`, {
      cause: error,
    });
  }
}

export async function processJevArticle(articleId: string): Promise<void> {
  await scoreArticleWithJev(articleId);
}
