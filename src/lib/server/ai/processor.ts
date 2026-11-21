import crypto from 'node:crypto';
import { getDb } from '#lib/server/db/index.ts';
import { getConfiguredAiClient, isAiProcessingConfigured } from './runtime';
import type { ArticleScore } from './types';
import { hasArticleAnalysisText } from './prompts';
import { parseJsonTextArray } from '#lib/server/normalization.ts';
import {
  applyPreferenceModelToArticle,
  updateHeuristicScore,
} from '#lib/server/preferences.ts';
import { markArticleForRankingRefresh } from '#lib/server/ranking-freshness.ts';
import { isRankingProviderConfigured } from './jev';

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

  if (!isAiProcessingConfigured()) return;

  const selectArticle = db.prepare(
    `
    SELECT a.title, a.summary, a.content, a.author, a.categories, a.published_at
    FROM articles a
    WHERE a.id = ?
  `,
  );
  const article = selectArticle.get(articleId) as
    ArticleAnalysisRow | undefined;
  if (!article) return;
  if (!hasArticleAnalysisText(article.summary, article.content)) {
    markAnalysisFailed(
      articleId,
      'skipped',
      'Article does not contain readable text',
    );
    return;
  }

  let analysis: Partial<ArticleScore>;
  try {
    const client = await getConfiguredAiClient();
    if (!client) {
      markAnalysisFailed(
        articleId,
        'skipped',
        'AI provider configuration is incomplete',
      );
      return;
    }
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

  db.transaction(() => {
    const current = selectArticle.get(articleId) as
      ArticleAnalysisRow | undefined;
    if (!current) return;
    if (
      current.content !== article.content ||
      current.summary !== article.summary
    ) {
      throw new Error('Article content changed while AI analysis was running');
    }
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

    const readerState = db
      .prepare(
        'SELECT read, saved, hidden, rejected, thumbs_down FROM articles WHERE id = ?',
      )
      .get(articleId) as {
      read: number;
      saved: number;
      hidden: number;
      rejected: number;
      thumbs_down: number;
    };
    const visible =
      !readerState.hidden && !readerState.rejected && !readerState.thumbs_down;
    const refreshRanking = visible && isRankingProviderConfigured();
    if (refreshRanking) {
      db.prepare(
        "UPDATE articles SET jev_score = NULL, jev_processed_at = NULL, jev_error = '' WHERE id = ?",
      ).run(articleId);
    }

    if (visible && !readerState.read && !readerState.saved) {
      applyPreferenceModelToArticle(articleId);
    } else {
      updateHeuristicScore(articleId);
    }

    if (
      refreshRanking &&
      db
        .prepare('SELECT 1 FROM articles WHERE id = ? AND hidden = 0')
        .get(articleId)
    ) {
      // Commit the refresh intent with enrichment even if the Jev job
      // queue is full. The worker will submit it when capacity returns.
      markArticleForRankingRefresh(articleId);
    }
  }).immediate();
}
