import {
  fetchSafe,
  MAX_JSON_RESPONSE_BYTES,
  readResponseText,
} from '#lib/server/network.ts';
import { ProviderHttpError, retryAtFromHeader } from './provider-error';
import fs from 'node:fs';
import { buildRankingPreferenceInput } from '#lib/server/ai/preference-input.ts';
import { getDb } from '#lib/server/db/index.ts';
import { parseJsonTextArray, stripHtml } from '#lib/server/normalization.ts';
import { refreshCombinedScore } from '#lib/server/scoring.ts';
import {
  buildSafeDecisionInput,
  JEV_DECISION_QUESTIONS,
} from '#lib/server/ai/decision-input.ts';
import {
  getRankingProviderSnapshot,
  type RankingProvider,
} from '#lib/server/ranking-provider.ts';
import {
  getRankingFeedbackRevision,
  markArticleForRankingRefresh,
} from '#lib/server/ranking-freshness.ts';

const JEV_ENDPOINT =
  process.env.TYPESAFE_API_URL ||
  process.env.JEV_API_URL ||
  'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const SUBQ_ENDPOINT = 'https://api.subq.ai/v1/systemone';
const SUBQ_MODEL = 'subq-snap-preview';
const PREFERENCE_HALF_LIFE_DAYS = 45;

type ArticleJevRow = {
  title: string | null;
  summary: string | null;
  content: string | null;
  content_length: number;
  author: string | null;
  categories: string | null;
  published_at: number | null;
  fetched_at: number;
  feed_title: string | null;
  feed_category: string | null;
  ai_summary: string | null;
  ai_analysis_status: string | null;
  ai_processed_at: number | null;
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
  return stripHtml(String(value || ''))
    .slice(0, limit)
    .trim();
}

function readApiKey(provider: RankingProvider): string {
  const direct =
    provider === 'jev'
      ? (process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || '').trim()
      : (process.env.SUBQ_API_KEY || '').trim();
  if (direct) return direct;

  const paths = (
    provider === 'jev'
      ? [
          process.env.TYPESAFE_API_KEY_FILE,
          process.env.JEV_API_KEY_FILE,
          '/run/secrets/typesafe_api_key',
          '/run/secrets/jev_api_key',
        ]
      : [process.env.SUBQ_API_KEY_FILE, '/run/secrets/subq_api_key']
  ).filter((value): value is string => Boolean(value));

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
  return Boolean(readApiKey('jev'));
}

export function isSubqConfigured(): boolean {
  return Boolean(readApiKey('subq'));
}

export function isRankingProviderConfigured(
  provider = getRankingProviderSnapshot().provider,
): boolean {
  return Boolean(readApiKey(provider));
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
        ORDER BY last_reinforced DESC
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
      positiveEvidenceCount: number;
      negativeEvidenceCount: number;
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
      positiveEvidenceCount: 0,
      negativeEvidenceCount: 0,
    };
    const decayed = decayedStrength(row.strength, row.last_reinforced);
    const evidence = Math.max(0, Number(row.evidence_count || 0));
    if (row.polarity === 'negative') {
      current.negative += decayed;
      current.negativeEvidenceCount += evidence;
    } else {
      current.positive += decayed;
      current.positiveEvidenceCount += evidence;
    }
    grouped.set(key, current);
  }

  const preferences = [...grouped.values()]
    .map((item) => {
      const net = item.positive - item.negative;
      return {
        ...item,
        net,
        evidenceCount:
          net >= 0 ? item.positiveEvidenceCount : item.negativeEvidenceCount,
      };
    })
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
        SELECT COALESCE(NULLIF(TRIM(f.title), ''), f.url) AS source,
               COUNT(DISTINCT a.id) AS interaction_count
        FROM user_interactions ui
        JOIN articles a ON a.id = ui.article_id
        JOIN feeds f ON f.id = a.feed_id
        WHERE ui.interaction_type IN ('open', 'read', 'thumbs_up', 'boost', 'save')
          AND COALESCE(a.thumbs_down, 0) = 0
          AND COALESCE(a.rejected, 0) = 0
          AND COALESCE(
            json_extract(
              CASE WHEN json_valid(ui.metadata) THEN ui.metadata ELSE '{}' END,
              '$.undone_at'
            ),
            0
          ) = 0
          AND NOT EXISTS (
            SELECT 1 FROM user_interactions ui_neg
            WHERE ui_neg.article_id = a.id
              AND ui_neg.interaction_type IN ('thumbs_down', 'hide')
              AND COALESCE(
                json_extract(
                  CASE WHEN json_valid(ui_neg.metadata) THEN ui_neg.metadata ELSE '{}' END,
                  '$.undone_at'
                ),
                0
              ) = 0
              AND (
                ui_neg.interaction_type = 'thumbs_down'
                OR COALESCE(
                  json_extract(
                    CASE WHEN json_valid(ui_neg.metadata) THEN ui_neg.metadata ELSE '{}' END,
                    '$.auto'
                  ),
                  0
                ) = 0
              )
          )
        GROUP BY f.id
        ORDER BY interaction_count DESC
        LIMIT 5
      `,
    )
    .all() as Array<{ source: string; interaction_count: number }>;
  const avoidedSourceRows = db
    .prepare(
      `
        SELECT COALESCE(NULLIF(TRIM(f.title), ''), f.url) AS source,
               COUNT(DISTINCT a.id) AS interaction_count
        FROM user_interactions ui
        JOIN articles a ON a.id = ui.article_id
        JOIN feeds f ON f.id = a.feed_id
        WHERE ui.interaction_type IN ('thumbs_down', 'hide')
          AND COALESCE(a.thumbs_up, 0) = 0
          AND COALESCE(
            json_extract(
              CASE WHEN json_valid(ui.metadata) THEN ui.metadata ELSE '{}' END,
              '$.undone_at'
            ),
            0
          ) = 0
          AND (
            ui.interaction_type = 'thumbs_down'
            OR COALESCE(
              json_extract(
                CASE WHEN json_valid(ui.metadata) THEN ui.metadata ELSE '{}' END,
                '$.auto'
              ),
              0
            ) = 0
          )
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
        SELECT a.title, a.summary, a.content, length(a.content) AS content_length,
               a.author, a.categories,
               a.published_at, a.fetched_at,
               COALESCE(NULLIF(TRIM(f.title), ''), f.url) AS feed_title, f.category AS feed_category,
               am.summary AS ai_summary, am.analysis_status AS ai_analysis_status,
               am.processed_at AS ai_processed_at, am.topics AS ai_topics,
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
  const hasReadyAnalysis = article.ai_analysis_status === 'ready';
  const publishedAt = Number(article.published_at || article.fetched_at || 0);
  const ageHours = publishedAt
    ? Math.max(0, (Date.now() - publishedAt) / (60 * 60 * 1000))
    : null;
  const categories = parseJsonTextArray(article.categories, 8);
  const topics = hasReadyAnalysis
    ? parseJsonTextArray(article.ai_topics, 8)
    : [];
  const entities = hasReadyAnalysis
    ? parseJsonTextArray(article.ai_entities, 8)
    : [];
  const signals = hasReadyAnalysis
    ? parseJsonTextArray(article.ai_signals, 8)
    : [];

  return buildRankingPreferenceInput(
    buildSafeDecisionInput({
      reader_profile: getReaderProfile(),
      candidate: {
        title: compactText(article.title, 240),
        author: compactText(article.author, 120),
        source: compactText(article.feed_title, 120),
        source_category: compactText(article.feed_category, 80),
        summary: compactText(
          (hasReadyAnalysis && article.ai_summary) || article.summary,
          1400,
        ),
        content_excerpt: compactText(article.content, 2200),
        categories,
        topics,
        entities,
        content_type: hasReadyAnalysis
          ? compactText(article.ai_content_type, 50)
          : '',
        signals,
        age_hours: ageHours == null ? null : Number(ageHours.toFixed(1)),
      },
    }),
  );
}

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Unknown ranking error'
  );
}

type RankingScoreResult = {
  score: number;
  model: string;
  usage?: Record<string, unknown>;
};

async function requestRankingScore(
  provider: RankingProvider,
  state: Record<string, unknown>,
  apiKey: string,
): Promise<RankingScoreResult> {
  const endpoint = provider === 'jev' ? JEV_ENDPOINT : SUBQ_ENDPOINT;
  const model = provider === 'jev' ? JEV_MODEL : SUBQ_MODEL;
  const providerName = provider === 'jev' ? 'TypeSafe' : 'SubQ';
  const { response } = await fetchSafe(
    endpoint,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state,
        model,
        questions: { would_open: JEV_DECISION_QUESTIONS.would_open },
      }),
      signal: AbortSignal.timeout(20_000),
    },
    { maxRedirects: 0, maxBytes: MAX_JSON_RESPONSE_BYTES },
  );

  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderHttpError(
      `${providerName} API returned HTTP ${response.status}`,
      response.status,
      retryAtFromHeader(response.headers.get('retry-after')),
    );
  }

  const data = JSON.parse(
    await readResponseText(response, MAX_JSON_RESPONSE_BYTES),
  ) as {
    model?: unknown;
    usage?: unknown;
    answers?: { would_open?: { noul?: unknown } };
  };
  const rawScore = data.answers?.would_open?.noul;
  if (
    typeof rawScore !== 'number' ||
    !Number.isFinite(rawScore) ||
    rawScore < 0 ||
    rawScore > 1
  ) {
    throw new Error(`${providerName} API returned no usable would_open score`);
  }
  return {
    score: rawScore,
    model: typeof data.model === 'string' && data.model ? data.model : model,
    ...(data.usage &&
    typeof data.usage === 'object' &&
    !Array.isArray(data.usage)
      ? { usage: data.usage as Record<string, unknown> }
      : {}),
  };
}

/**
 * Score one article with the selected ranking provider. The legacy Jev name is
 * retained because persisted worker jobs and callers use it as a stable API.
 */
async function scoreArticleWithJevInternal(
  articleId: string,
): Promise<RankingScoreResult | null> {
  const providerSnapshot = getRankingProviderSnapshot();
  const apiKey = readApiKey(providerSnapshot.provider);
  if (!apiKey) return null;

  const article = getArticle(articleId);
  if (!article) return null;

  const db = getDb();
  const profileRevision = getRankingFeedbackRevision();
  const readAnalysisVersion = db
    .prepare(
      'SELECT processed_at FROM article_ai_metadata WHERE article_id = ?',
    )
    .pluck();
  const readArticleSnapshot = db.prepare(
    'SELECT title, summary, length(content) AS content_length FROM articles WHERE id = ?',
  );
  const analysisChanged = () =>
    (readAnalysisVersion.get(articleId) ?? null) !== article.ai_processed_at;
  const articleSnapshotChanged = () => {
    const current = readArticleSnapshot.get(articleId) as
      | {
          title: string | null;
          summary: string | null;
          content_length: number | null;
        }
      | undefined;
    if (!current) return true;
    return (
      (current.title ?? null) !== (article.title ?? null) ||
      (current.summary ?? null) !== (article.summary ?? null) ||
      Number(current.content_length ?? 0) !==
        Number(article.content_length ?? 0)
    );
  };

  try {
    const outcome = await requestRankingScore(
      providerSnapshot.provider,
      buildState(article),
      apiKey,
    );
    const stored = db
      .transaction(() => {
        const currentRevision = getRankingFeedbackRevision();
        const currentProvider = getRankingProviderSnapshot();
        if (
          analysisChanged() ||
          articleSnapshotChanged() ||
          currentRevision !== profileRevision ||
          currentProvider.provider !== providerSnapshot.provider ||
          currentProvider.revision !== providerSnapshot.revision
        ) {
          markArticleForRankingRefresh(articleId, currentRevision);
          return false;
        }
        const now = Date.now();
        const result = db
          .prepare(
            `
              UPDATE articles
              SET jev_score = ?, jev_processed_at = ?, jev_error = '',
                  ranking_refreshed_at = ?
              WHERE id = ?
            `,
          )
          .run(outcome.score, now, now, articleId);
        if (result.changes === 0) return false;
        // A current-profile result can satisfy any older pending request for
        // this article, including a marker left by capacity or cooldown.
        db.prepare(
          'DELETE FROM ranking_refresh_queue WHERE article_id = ? AND requested_revision <= ?',
        ).run(articleId, profileRevision);
        refreshCombinedScore(articleId);
        return true;
      })
      .immediate();
    return stored ? outcome : null;
  } catch (error) {
    const message = truncateError(error);
    const recordError = db
      .transaction(() => {
        const currentRevision = getRankingFeedbackRevision();
        const currentProvider = getRankingProviderSnapshot();
        if (
          analysisChanged() ||
          articleSnapshotChanged() ||
          currentRevision !== profileRevision ||
          currentProvider.provider !== providerSnapshot.provider ||
          currentProvider.revision !== providerSnapshot.revision
        ) {
          markArticleForRankingRefresh(articleId, currentRevision);
          return false;
        }
        db.prepare(
          'UPDATE articles SET jev_processed_at = ?, jev_error = ? WHERE id = ?',
        ).run(Date.now(), message, articleId);
        return true;
      })
      .immediate();
    if (!recordError) return null;
    throw new Error(
      `${providerSnapshot.provider === 'jev' ? 'Jev' : 'SubQ'} scoring failed for ${articleId}: ${message}`,
      { cause: error },
    );
  }
}

export async function scoreArticleWithJev(
  articleId: string,
): Promise<number | null> {
  const result = await scoreArticleWithJevInternal(articleId);
  return result ? result.score : null;
}

export async function processJevArticle(
  articleId: string,
): Promise<{ model: string; usage?: Record<string, unknown> } | void> {
  const result = await scoreArticleWithJevInternal(articleId);
  if (!result) return;
  return {
    model: result.model,
    ...(result.usage ? { usage: result.usage } : {}),
  };
}
