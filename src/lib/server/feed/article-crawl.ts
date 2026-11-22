import { isAiProcessingConfigured } from '#lib/server/ai/runtime.ts';
import { hasArticleAnalysisText } from '#lib/server/ai/prompts.ts';
import { fetchPublisherArticle } from '#lib/server/archive.ts';
import { getDb } from '#lib/server/db/index.ts';
import {
  enqueueAiProcess,
  enqueueJevProcess,
} from '#lib/server/feed/job-queue.ts';
import { stripHtml } from '#lib/server/normalization.ts';
import {
  applyPreferenceModelToArticle,
  updateHeuristicScore,
} from '#lib/server/preferences.ts';
import { getConfiguredProxyBaseUrl } from '#lib/server/proxy.ts';
import { refreshCombinedScore } from '#lib/server/scoring.ts';

export type ArticleCrawlOutcome =
  | {
      status: 'upgraded';
      upgraded: true;
      content: string;
      imageUrl: string;
      extractedLength: number;
      previousLength: number;
    }
  | {
      status: 'unchanged';
      upgraded: false;
      content: string;
      imageUrl: string;
      extractedLength: number;
      previousLength: number;
    }
  | {
      status: 'skipped';
      upgraded: false;
      reason: string;
    }
  | {
      status: 'failed';
      upgraded: false;
      error: string;
    };

type ArticleCrawlRow = {
  id: string;
  feed_id: string;
  url: string;
  external_url: string | null;
  summary: string | null;
  content: string | null;
  image_url: string | null;
  read: number | null;
  saved: number | null;
  hidden: number | null;
  rejected: number | null;
  thumbs_down: number | null;
  cleared_at: number | null;
  feed_enabled: number | null;
  feed_use_proxy: number | null;
  feed_fetch_full_text: number | null;
  feed_css_selector: string | null;
};

function getStoredPlainTextLength(
  content: string | null | undefined,
  summary: string | null | undefined,
): number {
  return Math.max(
    stripHtml(content || '').length,
    stripHtml(summary || '').length,
  );
}

export async function crawlAndSaveArticleFullText(
  articleId: string,
  options: {
    /** Allow interactive reader extraction even if automatic feed crawling is off or article was auto-hidden on open. */
    interactive?: boolean;
    now?: number;
  } = {},
): Promise<ArticleCrawlOutcome> {
  const db = getDb();
  const initial = db
    .prepare(
      `
        SELECT a.id, a.feed_id, a.url, a.external_url, a.summary, a.content,
               a.image_url, a.read, a.saved, a.hidden, a.rejected, a.thumbs_down,
               a.cleared_at,
               f.enabled AS feed_enabled,
               f.use_proxy AS feed_use_proxy,
               f.fetch_full_text AS feed_fetch_full_text,
               f.css_selector AS feed_css_selector
        FROM articles a
        JOIN feeds f ON f.id = a.feed_id
        WHERE a.id = ?
      `,
    )
    .get(articleId) as ArticleCrawlRow | undefined;

  if (!initial) {
    return { status: 'skipped', upgraded: false, reason: 'article_not_found' };
  }

  if (!options.interactive) {
    if (!initial.feed_enabled || !initial.feed_fetch_full_text) {
      return { status: 'skipped', upgraded: false, reason: 'feed_inactive' };
    }
    if (
      initial.cleared_at != null ||
      initial.hidden ||
      initial.rejected ||
      initial.thumbs_down
    ) {
      return { status: 'skipped', upgraded: false, reason: 'article_hidden' };
    }
  }

  const targetUrl = (initial.external_url || '').trim() || initial.url;
  if (!targetUrl) {
    return {
      status: 'failed',
      upgraded: false,
      error: 'Article has no publisher URL',
    };
  }

  const proxyBaseUrl = initial.feed_use_proxy
    ? getConfiguredProxyBaseUrl()
    : undefined;
  const cssSelector = initial.feed_css_selector?.trim() || undefined;
  const extracted = await fetchPublisherArticle(
    targetUrl,
    proxyBaseUrl,
    cssSelector,
  );
  if (!extracted || !extracted.content?.trim()) {
    return {
      status: 'failed',
      upgraded: false,
      error: 'Failed to extract full text from publisher',
    };
  }

  const extractedPlainLength = stripHtml(extracted.content).length;
  const queueAi = isAiProcessingConfigured();
  const commitNow = options.now ?? Date.now();

  const txResult = db
    .transaction(() => {
      const fresh = db
        .prepare(
          `
            SELECT a.id, a.feed_id, a.url, a.external_url, a.summary, a.content,
                   a.image_url, a.read, a.saved, a.hidden, a.rejected, a.thumbs_down,
                   a.cleared_at,
                   f.enabled AS feed_enabled,
                   f.use_proxy AS feed_use_proxy,
                   f.fetch_full_text AS feed_fetch_full_text,
                   f.css_selector AS feed_css_selector
            FROM articles a
            JOIN feeds f ON f.id = a.feed_id
            WHERE a.id = ?
          `,
        )
        .get(articleId) as ArticleCrawlRow | undefined;

      if (!fresh) {
        return {
          outcome: {
            status: 'skipped',
            upgraded: false,
            reason: 'article_not_found',
          } satisfies ArticleCrawlOutcome,
          shouldQueueScoring: false,
          feedId: initial.feed_id,
          summary: null as string | null,
        };
      }

      if (!options.interactive) {
        if (!fresh.feed_enabled || !fresh.feed_fetch_full_text) {
          return {
            outcome: {
              status: 'skipped',
              upgraded: false,
              reason: 'feed_inactive',
            } satisfies ArticleCrawlOutcome,
            shouldQueueScoring: false,
            feedId: fresh.feed_id,
            summary: fresh.summary,
          };
        }
        if (
          fresh.cleared_at != null ||
          fresh.hidden ||
          fresh.rejected ||
          fresh.thumbs_down
        ) {
          return {
            outcome: {
              status: 'skipped',
              upgraded: false,
              reason: 'article_hidden',
            } satisfies ArticleCrawlOutcome,
            shouldQueueScoring: false,
            feedId: fresh.feed_id,
            summary: fresh.summary,
          };
        }
      }

      const previousLength = getStoredPlainTextLength(
        fresh.content,
        fresh.summary,
      );
      if (extractedPlainLength <= previousLength) {
        return {
          outcome: {
            status: 'unchanged',
            upgraded: false,
            content: fresh.content || '',
            imageUrl: fresh.image_url || '',
            extractedLength: extractedPlainLength,
            previousLength,
          } satisfies ArticleCrawlOutcome,
          shouldQueueScoring: false,
          feedId: fresh.feed_id,
          summary: fresh.summary,
        };
      }

      const nextImageUrl =
        fresh.image_url?.trim() || extracted.imageUrl?.trim() || '';

      db.prepare(
        `
          UPDATE articles
          SET content = ?,
              image_url = COALESCE(NULLIF(image_url, ''), ?),
              jev_score = NULL,
              jev_processed_at = NULL,
              jev_error = '',
              updated_at = ?
          WHERE id = ?
        `,
      ).run(
        extracted.content,
        extracted.imageUrl || null,
        commitNow,
        articleId,
      );

      db.prepare(
        `
          DELETE FROM jobs
          WHERE type = 'jev_process'
            AND status IN ('completed', 'failed')
            AND json_valid(payload) = 1
            AND json_extract(payload, '$.articleId') = ?
        `,
      ).run(articleId);

      if (queueAi) {
        db.prepare(
          `
            UPDATE article_ai_metadata
            SET analysis_status = 'pending',
                analysis_error = '',
                processed_at = NULL
            WHERE article_id = ?
          `,
        ).run(articleId);
      }

      let isVisible =
        Boolean(fresh.feed_enabled) &&
        fresh.cleared_at == null &&
        !fresh.hidden &&
        !fresh.rejected &&
        !fresh.thumbs_down;

      if (isVisible && !fresh.read && !fresh.saved) {
        applyPreferenceModelToArticle(articleId);
        const refreshed = db
          .prepare(
            'SELECT hidden, rejected, thumbs_down FROM articles WHERE id = ?',
          )
          .get(articleId) as
          { hidden: number; rejected: number; thumbs_down: number } | undefined;
        isVisible =
          Boolean(refreshed) &&
          !refreshed?.hidden &&
          !refreshed?.rejected &&
          !refreshed?.thumbs_down;
      }

      updateHeuristicScore(articleId);
      refreshCombinedScore(articleId);

      return {
        outcome: {
          status: 'upgraded',
          upgraded: true,
          content: extracted.content,
          imageUrl: nextImageUrl,
          extractedLength: extractedPlainLength,
          previousLength,
        } satisfies ArticleCrawlOutcome,
        shouldQueueScoring: isVisible,
        feedId: fresh.feed_id,
        summary: fresh.summary,
      };
    })
    .immediate();

  if (txResult.outcome.upgraded && txResult.shouldQueueScoring) {
    if (
      queueAi &&
      hasArticleAnalysisText(txResult.summary, txResult.outcome.content)
    ) {
      enqueueAiProcess(articleId, { feedId: txResult.feedId, now: commitNow });
    } else {
      enqueueJevProcess(articleId, { feedId: txResult.feedId, now: commitNow });
    }
  }

  return txResult.outcome;
}
