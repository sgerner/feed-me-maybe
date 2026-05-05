import crypto from 'node:crypto';
import { getDb } from '$lib/server/db';
import { createAiClient } from '$lib/server/ai/client';
import { getProvider } from '$lib/server/ai/models-dev';
import { decrypt } from './crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

type ArticleAnalysisRow = {
  title: string;
  summary: string | null;
  content: string | null;
  author: string | null;
  categories: string | null;
  published_at: number | string | Date | null;
};

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

function coerceTimestamp(value: number | string | Date | null): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getAgeBucket(value: number | string | Date | null): string {
  const timestamp = coerceTimestamp(value);
  if (!timestamp) return '';
  const ageDays = Math.max(0, (Date.now() - timestamp) / DAY_MS);
  if (ageDays < 1) return 'today';
  if (ageDays < 7) return 'this_week';
  if (ageDays < 30) return 'this_month';
  if (ageDays < 180) return 'this_year';
  return 'older';
}

function clampScore(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

export async function processArticle(articleId: string): Promise<void> {
  const db = getDb();

  const config = db
    .prepare('SELECT * FROM provider_configs WHERE enabled = 1 LIMIT 1')
    .get() as Record<string, any> | undefined;
  if (!config) return;

  const article = db
    .prepare(
      `
    SELECT a.title, a.summary, a.content, a.author, a.categories, a.published_at
    FROM articles a
    WHERE a.id = ?
  `,
    )
    .get(articleId) as ArticleAnalysisRow | undefined;
  if (!article) return;

  const decryptedConfigRaw = decrypt(
    config.api_key_encrypted || '',
    config.api_key_nonce || '',
  );
  if (!decryptedConfigRaw) return;

  const decryptedConfig: Record<string, string> = (() => {
    try {
      return JSON.parse(decryptedConfigRaw) as Record<string, string>;
    } catch {
      // Fallback for old single-key configs
      return { apiKey: decryptedConfigRaw };
    }
  })();

  const providerInfo = await getProvider(config.provider_id);
  const baseUrl = config.custom_base_url || providerInfo?.baseUrl || '';

  // Try to find an API key. Prefer the first required one, or any key if none specified.
  const apiKey = providerInfo?.requiredEnvVars?.length
    ? decryptedConfig[providerInfo.requiredEnvVars[0]] ||
      Object.values(decryptedConfig)[0] ||
      ''
    : decryptedConfig.apiKey || Object.values(decryptedConfig)[0] || '';

  if (!apiKey || !baseUrl) return;

  const client = createAiClient({
    baseUrl,
    apiKey,
    model: config.model_id,
  });

  const analysis = await client.analyzeArticle({
    title: article.title,
    summary: article.summary || '',
    content: article.content || '',
    author: article.author || '',
    publishedAge: getAgeBucket(article.published_at),
    categories: parseJsonArray(article.categories),
  });

  const now = Date.now();
  const topicsJson = JSON.stringify(analysis.topics || []);
  const entitiesJson = JSON.stringify(analysis.entities || []);
  const signalsJson = JSON.stringify(analysis.signals || []);
  const contentType = String(analysis.contentType || '');
  const aiSummary = String(analysis.summary || '');
  const aiRelevanceScore = clampScore(analysis.relevanceScore);
  const noveltyScore = clampScore(analysis.noveltyScore);
  const qualityScore = clampScore(analysis.qualityScore);
  const likelyInterest = String(analysis.likelyUserInterest || '');
  const explanation = String(analysis.explanation || '');

  const existing = db
    .prepare('SELECT id FROM article_ai_metadata WHERE article_id = ?')
    .get(articleId);
  if (existing) {
    db.prepare(
      `
      UPDATE article_ai_metadata
      SET summary = ?, topics = ?, entities = ?, content_type = ?,
          ai_relevance_score = ?, novelty_score = ?, quality_score = ?, likely_user_interest = ?,
          signals = ?, explanation = ?, processed_at = ?
      WHERE article_id = ?
    `,
    ).run(
      aiSummary,
      topicsJson,
      entitiesJson,
      contentType,
      aiRelevanceScore,
      noveltyScore,
      qualityScore,
      likelyInterest,
      signalsJson,
      explanation,
      now,
      articleId,
    );
  } else {
    db.prepare(
      `
      INSERT INTO article_ai_metadata (
        id, article_id, summary, topics, entities, content_type,
        ai_relevance_score, novelty_score, quality_score, likely_user_interest,
        signals, explanation, processed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      crypto.randomUUID(),
      articleId,
      aiSummary,
      topicsJson,
      entitiesJson,
      contentType,
      aiRelevanceScore,
      noveltyScore,
      qualityScore,
      likelyInterest,
      signalsJson,
      explanation,
      now,
      now,
    );
  }

  // Combined score: 60% user heuristic, 40% AI. Quality now contributes to AI ranking.
  const articleRow = db
    .prepare('SELECT heuristic_score FROM articles WHERE id = ?')
    .get(articleId) as { heuristic_score: number } | undefined;
  const heuristic = articleRow?.heuristic_score || 50;
  const hasMeaningfulAnalysis =
    Boolean(aiSummary) ||
    (analysis.topics?.length || 0) > 0 ||
    (analysis.entities?.length || 0) > 0 ||
    Boolean(contentType) ||
    (analysis.signals?.length || 0) > 0 ||
    aiRelevanceScore > 0 ||
    noveltyScore > 0 ||
    qualityScore > 0;

  const aiComposite =
    aiRelevanceScore * 0.7 + qualityScore * 0.2 + noveltyScore * 0.1;
  const combined = hasMeaningfulAnalysis
    ? Math.round(heuristic * 0.6 + aiComposite * 100 * 0.4)
    : Math.round(heuristic);

  db.prepare('UPDATE articles SET combined_score = ? WHERE id = ?').run(
    Math.max(0, Math.min(100, combined)),
    articleId,
  );

}
