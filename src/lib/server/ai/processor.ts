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
  url: string;
  summary: string | null;
  content: string | null;
  author: string | null;
  categories: string | null;
  published_at: number | string | Date | null;
  hidden: number | null;
  rejected: number | null;
  thumbs_down: number | null;
};

type CachedAiMetadataRow = {
  summary: string | null;
  topics: string | null;
  entities: string | null;
  content_type: string | null;
  ai_relevance_score: number | null;
  novelty_score: number | null;
  quality_score: number | null;
  likely_user_interest: string | null;
  signals: string | null;
  explanation: string | null;
};

export type ProcessArticleTelemetry = {
  model?: string;
  usage?: Record<string, number>;
  cached?: boolean;
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

function parseCachedStringArray(raw: string | null | undefined): string[] {
  return parseJsonTextArray(raw);
}

function findReusableAnalysis(
  articleId: string,
  article: ArticleAnalysisRow,
): Partial<ArticleScore> | null {
  const db = getDb();
  const hasContentMatch = (article.content || '').trim().length > 100;
  const cached = db
    .prepare(
      `
        SELECT am.summary, am.topics, am.entities, am.content_type,
               am.ai_relevance_score, am.novelty_score, am.quality_score,
               am.likely_user_interest, am.signals, am.explanation
        FROM article_ai_metadata am
        JOIN articles a ON a.id = am.article_id
        WHERE a.id != ?
          AND am.analysis_status = 'ready'
          AND (
            a.url = ?
            OR (
              ? = 1
              AND LOWER(TRIM(a.title)) = LOWER(TRIM(?))
              AND a.content = ?
            )
          )
        ORDER BY am.processed_at DESC, am.created_at DESC
        LIMIT 1
      `,
    )
    .get(
      articleId,
      article.url,
      hasContentMatch ? 1 : 0,
      article.title || '',
      article.content || '',
    ) as CachedAiMetadataRow | undefined;
  if (!cached) return null;

  return {
    summary: cached.summary || '',
    topics: parseCachedStringArray(cached.topics),
    entities: parseCachedStringArray(cached.entities),
    contentType: cached.content_type || '',
    relevanceScore: clampScore(cached.ai_relevance_score),
    noveltyScore: clampScore(cached.novelty_score),
    qualityScore: clampScore(cached.quality_score),
    likelyUserInterest: cached.likely_user_interest || '',
    signals: parseCachedStringArray(cached.signals),
    explanation: cached.explanation || '',
  };
}

export async function processArticle(
  articleId: string,
): Promise<ProcessArticleTelemetry | void> {
  const db = getDb();

  if (!isAiProcessingConfigured()) return;

  const selectArticle = db.prepare(
    `
    SELECT a.title, a.url, a.summary, a.content, a.author, a.categories,
           a.published_at, a.hidden, a.rejected, a.thumbs_down
    FROM articles a
    WHERE a.id = ?
  `,
  );
  const article = selectArticle.get(articleId) as
    ArticleAnalysisRow | undefined;
  if (!article || article.hidden || article.rejected || article.thumbs_down) {
    return;
  }
  if (!hasArticleAnalysisText(article.summary, article.content)) {
    markAnalysisFailed(
      articleId,
      'skipped',
      'Article does not contain readable text',
    );
    return;
  }

  let analysis: Partial<ArticleScore>;
  let model: string | undefined;
  let usage: Record<string, number> | undefined;
  let cached = false;

  const reusable = findReusableAnalysis(articleId, article);
  if (reusable && hasMeaningfulAnalysis(reusable)) {
    analysis = reusable;
    cached = true;
  } else {
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
      const input = {
        title: article.title,
        summary: article.summary || '',
        content: article.content || '',
        author: article.author || '',
        publishedAge: getAgeBucket(article.published_at),
        categories: parseJsonTextArray(article.categories),
      };
      if (
        'analyzeArticleWithMeta' in client &&
        typeof client.analyzeArticleWithMeta === 'function'
      ) {
        const result = await client.analyzeArticleWithMeta(input);
        analysis = result.analysis;
        model = result.model;
        usage = result.usage;
      } else {
        analysis = await client.analyzeArticle(input);
      }
    } catch (error) {
      const message = truncateError(error);
      markAnalysisFailed(articleId, 'failed', message);
      throw new Error(`AI analysis failed for ${articleId}: ${message}`, {
        cause: error,
      });
    }
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

  const committed = db
    .transaction(() => {
      if (!isAiProcessingConfigured()) return false;
      const current = selectArticle.get(articleId) as
        ArticleAnalysisRow | undefined;
      if (!current || current.hidden || current.rejected || current.thumbs_down)
        return false;
      if (
        current.content !== article.content ||
        current.summary !== article.summary
      ) {
        throw new Error(
          'Article content changed while AI analysis was running',
        );
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
          'SELECT read, saved, hidden, rejected, thumbs_up, thumbs_down FROM articles WHERE id = ?',
        )
        .get(articleId) as {
        read: number;
        saved: number;
        hidden: number;
        rejected: number;
        thumbs_up: number;
        thumbs_down: number;
      };
      const visible =
        !readerState.hidden &&
        !readerState.rejected &&
        !readerState.thumbs_down;
      const refreshRanking = visible && isRankingProviderConfigured();
      if (refreshRanking) {
        db.prepare(
          "UPDATE articles SET jev_score = NULL, jev_processed_at = NULL, jev_error = '' WHERE id = ?",
        ).run(articleId);
      }

      if (
        visible &&
        !readerState.read &&
        !readerState.saved &&
        !readerState.thumbs_up
      ) {
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
      return true;
    })
    .immediate();

  if (!committed) return;
  if (cached || model || usage) {
    return {
      ...(cached ? { cached: true } : {}),
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}
