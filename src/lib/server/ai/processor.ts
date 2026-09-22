import crypto from 'node:crypto';
import { getDb } from '$lib/server/db';
import { createAiClient } from '$lib/server/ai/client';
import { getProvider } from '$lib/server/ai/models-dev';
import { decrypt } from './crypto';
import { parseJsonTextArray } from '$lib/server/normalization';
import { refreshCombinedScore } from '$lib/server/scoring';
import { recordAppError } from '$lib/server/logging';

const DAY_MS = 24 * 60 * 60 * 1000;

type ArticleAnalysisRow = {
  title: string;
  summary: string | null;
  content: string | null;
  author: string | null;
  categories: string | null;
  published_at: number | string | Date | null;
};

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

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Unknown AI error'
  );
}

function markAnalysisFailed(
  articleId: string,
  status: 'failed' | 'skipped',
  message: string,
): void {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .prepare('SELECT id FROM article_ai_metadata WHERE article_id = ?')
    .get(articleId) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      'UPDATE article_ai_metadata SET analysis_status = ?, analysis_error = ?, processed_at = ? WHERE article_id = ?',
    ).run(status, message, now, articleId);
  } else {
    db.prepare(
      `INSERT INTO article_ai_metadata
       (id, article_id, analysis_status, analysis_error, processed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(crypto.randomUUID(), articleId, status, message, now, now);
  }
}

function hasMeaningfulAnalysis(analysis: Record<string, any>): boolean {
  return (
    Boolean(analysis.summary) ||
    (analysis.topics?.length || 0) > 0 ||
    (analysis.entities?.length || 0) > 0 ||
    Boolean(analysis.contentType) ||
    (analysis.signals?.length || 0) > 0 ||
    Number(analysis.relevanceScore || 0) > 0 ||
    Number(analysis.noveltyScore || 0) > 0 ||
    Number(analysis.qualityScore || 0) > 0
  );
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
  if (!decryptedConfigRaw) {
    markAnalysisFailed(
      articleId,
      'skipped',
      'AI provider API key is not configured',
    );
    return;
  }

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

  if (!apiKey || !baseUrl) {
    markAnalysisFailed(
      articleId,
      'skipped',
      'AI provider configuration is incomplete',
    );
    return;
  }

  const client = createAiClient({
    baseUrl,
    apiKey,
    model: config.model_id,
    providerId: config.provider_id,
  });

  let analysis: Awaited<ReturnType<typeof client.analyzeArticle>>;
  try {
    analysis = await client.analyzeArticle({
      title: article.title,
      summary: article.summary || '',
      content: article.content || '',
      author: article.author || '',
      publishedAge: getAgeBucket(article.published_at),
      categories: parseJsonTextArray(article.categories),
    });
  } catch (error) {
    const message = truncateError(error);
    markAnalysisFailed(articleId, 'failed', message);
    throw new Error(`AI analysis failed for ${articleId}: ${message}`, {
      cause: error,
    });
  }

  if (!hasMeaningfulAnalysis(analysis)) {
    const message = 'AI provider returned no usable article analysis';
    markAnalysisFailed(articleId, 'failed', message);
    throw new Error(`AI analysis failed for ${articleId}: ${message}`);
  }

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
          signals = ?, explanation = ?, analysis_status = 'ready', analysis_error = '', processed_at = ?
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
        , analysis_status, analysis_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', '')
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

  // Recompute after enrichment. If a Jev score is already present, this
  // activates the hybrid score; otherwise it preserves the LLM-only formula.
  refreshCombinedScore(articleId);

  // Jev's candidate state includes this newly extracted enrichment, so
  // refresh its judgment whenever an LLM analysis succeeds. The queue
  // deduplicates an already queued or processing Jev job for this article.
  try {
    const { enqueueJevProcess } = await import('$lib/server/feed/job-queue');
    enqueueJevProcess(articleId);
  } catch (error) {
    recordAppError({
      source: 'ai.processor.jev.enqueue',
      error,
      details: { articleId },
    });
  }
}
