import { isAiProcessingConfigured } from '$lib/server/ai/runtime';
import { hasArticleAnalysisText } from '$lib/server/ai/prompts';
import { normalizeSourceUrl } from '$lib/server/source-url';
import { getDb } from '$lib/server/db';
import { fetchFeed } from '$lib/server/feed/fetcher';
import {
  isRedditUrl,
  normalizeRedditUrl,
  fetchRedditSource,
} from '$lib/server/sources/reddit';
import { applyPreferenceModelToArticle } from '$lib/server/preferences';
import { refreshCombinedScore } from '$lib/server/scoring';
import { dispatchWebhookEvent } from '$lib/server/webhooks';
import { broadcast } from '$lib/server/realtime';
import { getConfiguredProxyBaseUrl } from '$lib/server/proxy';
import { recordAppError } from '$lib/server/logging';
import {
  enqueueAiProcess,
  enqueueJevProcess,
} from '$lib/server/feed/job-queue';
import { normalizeFeedUrl } from '$lib/server/feed-management';
import crypto from 'node:crypto';

interface IngestOptions {
  feedId: string;
  force?: boolean;
  countFailure?: boolean;
}

interface IngestResult {
  success: boolean;
  articlesFound: number;
  articlesNew: number;
  skipped?: boolean;
  status?: 'completed' | 'already_running';
  error?: string;
  retryAt?: number;
  permanentFailure?: boolean;
  feedTitle?: string;
  feedDescription?: string;
  feedLink?: string;
  feedImageUrl?: string;
}

export function normalizeArticleUrl(value: string): string {
  return normalizeSourceUrl(value, true, true);
}
function normalizeGuid(value: string | undefined): string {
  return String(value || '').trim();
}

export function generateArticleId(
  feedId: string,
  url: string,
  title: string,
  guid?: string,
): string {
  const normalizedGuid = normalizeGuid(guid);
  const identity = normalizedGuid
    ? `${feedId}|guid|${normalizedGuid}`
    : `${feedId}|url|${normalizeArticleUrl(url)}|title|${title.trim().toLowerCase()}`;
  return crypto
    .createHash('sha256')
    .update(identity)
    .digest('hex')
    .substring(0, 32);
}

function legacyArticleId(url: string, title: string, guid?: string): string {
  const identity = guid ? guid : `${url}|${title}`;
  return crypto
    .createHash('sha256')
    .update(identity)
    .digest('hex')
    .substring(0, 32);
}

function parseSourceMetadata(value: string | null | undefined): {
  originalUrl?: string;
} {
  if (!value) return {};
  try {
    return JSON.parse(value) as { originalUrl?: string };
  } catch {
    return {};
  }
}

function hasArticleColumn(column: string): boolean {
  const columns = getDb()
    .prepare('PRAGMA table_info(articles)')
    .all() as Array<{
    name: string;
  }>;
  return columns.some((candidate) => candidate.name === column);
}

export async function ingestFeed(
  options: IngestOptions,
): Promise<IngestResult> {
  const db = getDb();
  const { feedId } = options;

  const feedRecord = db
    .prepare(
      'SELECT url, etag, last_modified_header, fetch_count_since_change, custom_title, source_type, source_metadata, use_proxy FROM feeds WHERE id = ?',
    )
    .get(feedId) as
    | {
        url: string;
        etag: string | null;
        last_modified_header: string | null;
        fetch_count_since_change: number;
        custom_title: number;
        source_type: string | null;
        source_metadata: string | null;
        use_proxy: number | null;
      }
    | undefined;

  if (!feedRecord) {
    recordAppError({
      source: 'feed.ingester',
      error: new Error(`Feed not found: ${feedId}`),
      details: { feedId },
    });
    return {
      success: false,
      articlesFound: 0,
      articlesNew: 0,
      error: 'Feed not found',
      permanentFailure: true,
    };
  }

  const startedAt = Date.now();
  const logId = db
    .transaction(() => {
      const staleBefore = startedAt - 10 * 60 * 1000;
      db.prepare(
        `
          UPDATE feed_fetch_logs
          SET status = 'error',
              error_message = 'Fetch abandoned after its lease expired',
              completed_at = ?
          WHERE feed_id = ? AND status IN ('pending', 'fetching')
            AND started_at IS NOT NULL AND started_at < ?
        `,
      ).run(startedAt, feedId, staleBefore);

      const activeFetch = db
        .prepare(
          `
            SELECT id FROM feed_fetch_logs
            WHERE feed_id = ? AND status IN ('pending', 'fetching')
            LIMIT 1
          `,
        )
        .get(feedId) as { id: string } | undefined;
      if (activeFetch) return null;

      const nextLogId = crypto.randomUUID();
      db.prepare(
        'INSERT INTO feed_fetch_logs (id, feed_id, status, started_at, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(nextLogId, feedId, 'fetching', startedAt, startedAt);
      db.prepare(
        "UPDATE feeds SET last_fetch_status = 'fetching', last_fetch_at = ?, updated_at = ? WHERE id = ?",
      ).run(startedAt, startedAt, feedId);
      return nextLogId;
    })
    .immediate() as string | null;

  if (!logId) {
    return {
      success: true,
      articlesFound: 0,
      articlesNew: 0,
      skipped: true,
      status: 'already_running',
      error: 'Feed refresh already in progress',
    };
  }

  const sourceType = feedRecord.source_type || 'rss';
  const sourceMetadata = parseSourceMetadata(feedRecord.source_metadata);
  const canonicalUrl =
    sourceType === 'reddit'
      ? sourceMetadata.originalUrl || feedRecord.url
      : normalizeFeedUrl(feedRecord.url);
  const proxyBaseUrl = getConfiguredProxyBaseUrl();
  const proxyEnabled =
    Boolean(feedRecord.use_proxy && proxyBaseUrl) &&
    (sourceType !== 'reddit' ||
      Boolean(sourceMetadata.originalUrl) ||
      isRedditUrl(feedRecord.url));

  let fetchResult;
  if (sourceType === 'reddit') {
    const shouldNormalizeReddit = Boolean(
      sourceMetadata.originalUrl || isRedditUrl(feedRecord.url),
    );
    const redditSource = shouldNormalizeReddit
      ? normalizeRedditUrl(canonicalUrl)
      : {
          originalUrl: canonicalUrl,
          normalizedUrl: canonicalUrl,
          redditKind: 'unknown' as const,
          fetchUrl: canonicalUrl,
        };
    fetchResult = await fetchRedditSource(redditSource, {
      proxyBaseUrl: proxyEnabled ? proxyBaseUrl : undefined,
      etag: options.force ? undefined : feedRecord.etag || undefined,
      lastModified: options.force
        ? undefined
        : feedRecord.last_modified_header || undefined,
    });
  } else {
    fetchResult = await fetchFeed(canonicalUrl, {
      etag: options.force ? undefined : feedRecord.etag || undefined,
      lastModified: options.force
        ? undefined
        : feedRecord.last_modified_header || undefined,
      proxyBaseUrl: feedRecord.use_proxy ? proxyBaseUrl : undefined,
    });
  }

  const current = db
    .prepare('SELECT url FROM feeds WHERE id = ?')
    .get(feedId) as { url: string } | undefined;
  if (current?.url !== feedRecord.url) {
    db.prepare(
      'UPDATE feed_fetch_logs SET status = ?, completed_at = ? WHERE id = ?',
    ).run('success', Date.now(), logId);
    return {
      success: true,
      articlesFound: 0,
      articlesNew: 0,
      status: 'completed',
    };
  }

  if (sourceType === 'reddit') {
    const normalizedUrl = normalizeRedditUrl(canonicalUrl).normalizedUrl;
    if (feedRecord.url !== normalizedUrl) {
      db.prepare('UPDATE feeds SET url = ?, updated_at = ? WHERE id = ?').run(
        normalizedUrl,
        Date.now(),
        feedId,
      );
    }
  } else if (feedRecord.url !== canonicalUrl) {
    const duplicateFeed = db
      .prepare('SELECT id FROM feeds WHERE url = ? AND id != ?')
      .get(canonicalUrl, feedId) as { id: string } | undefined;
    if (!duplicateFeed) {
      db.prepare('UPDATE feeds SET url = ?, updated_at = ? WHERE id = ?').run(
        canonicalUrl,
        Date.now(),
        feedId,
      );
    }
  }

  if (fetchResult.notModified) {
    db.prepare(
      'UPDATE feed_fetch_logs SET status = ?, articles_found = 0, articles_new = 0, completed_at = ? WHERE id = ?',
    ).run('success', Date.now(), logId);
    db.prepare(
      "UPDATE feeds SET last_fetch_status = 'success', error_count = 0, last_error = '', fetch_count_since_change = ?, updated_at = ? WHERE id = ?",
    ).run((feedRecord?.fetch_count_since_change || 0) + 1, Date.now(), feedId);
    return {
      success: true,
      articlesFound: 0,
      articlesNew: 0,
      status: 'completed',
    };
  }

  if (!fetchResult.success) {
    db.prepare(
      'UPDATE feed_fetch_logs SET status = ?, error_message = ?, completed_at = ? WHERE id = ?',
    ).run('error', fetchResult.error || 'Unknown error', Date.now(), logId);
    db.prepare(
      "UPDATE feeds SET last_fetch_status = 'error', last_error = ?, error_count = COALESCE(error_count, 0) + ?, updated_at = ? WHERE id = ?",
    ).run(
      fetchResult.error || 'Unknown error',
      options.countFailure === false ? 0 : 1,
      Date.now(),
      feedId,
    );
    recordAppError({
      source: 'feed.ingester.fetch',
      error: fetchResult.error || 'Unknown error',
      details: {
        feedId,
        sourceType,
        proxyEnabled,
        proxyConfigured: Boolean(proxyBaseUrl),
        canonicalUrl,
        httpStatus: fetchResult.httpStatus ?? null,
      },
    });
    return {
      success: false,
      articlesFound: 0,
      articlesNew: 0,
      error: fetchResult.error,
      retryAt: fetchResult.retryAt,
      permanentFailure: fetchResult.httpStatus === 410,
    };
  }

  // Prepare feed metadata and cache headers with the article batch. If any
  // article write rolls back, the next fetch must still use the prior ETag.
  const updates: string[] = [];
  const values: (string | number | null)[] = [];
  if (fetchResult.title && !feedRecord?.custom_title) {
    updates.push('title = ?');
    values.push(fetchResult.title);
  }
  if (fetchResult.description) {
    updates.push('description = ?');
    values.push(fetchResult.description);
  }
  if (fetchResult.link) {
    updates.push('site_url = ?');
    values.push(fetchResult.link);
  }
  if (fetchResult.imageUrl) {
    updates.push('icon_url = ?');
    values.push(fetchResult.imageUrl);
  }

  updates.push('etag = ?', 'last_modified_header = ?');
  values.push(fetchResult.etag || null, fetchResult.lastModified || null);

  // Process articles in a transaction for atomicity
  const newArticleIds: string[] = [];
  const webhookArticles: Record<string, unknown>[] = [];
  const aiQueuedArticleIds = new Set<string>();
  const rankingArticleIds = new Set<string>();
  const queueAi = fetchResult.items.length > 0 && isAiProcessingConfigured();
  // Older databases created before the additive external_url migration may
  // not have this optional column. Keep ingestion compatible without changing
  // schema or losing the rest of the article row.
  const supportsExternalUrl = hasArticleColumn('external_url');
  const ingestTx = db.transaction(() => {
    let articlesNew = 0;
    type ExistingArticle = {
      id: string;
      url: string;
      guid: string | null;
      title: string | null;
      image_url: string | null;
      content_length_lower: number | null;
      content_length_upper: number | null;
      has_content: number;
      has_summary: number;
      hidden: number;
      rejected: number;
      thumbs_down: number;
      author: string | null;
      categories: string | null;
      external_url: string | null;
    };

    // Build a per-feed identity index once. This catches older rows whose URL
    // still contains tracking parameters and prevents duplicate rows when a
    // provider changes its GUID or returns the same entry twice in one fetch.
    const existingRows = db
      .prepare(
        `
          SELECT id, url, guid, title, image_url,
                 length(content) AS content_length_lower,
                 length(CAST(content AS BLOB)) AS content_length_upper,
                 CASE WHEN content IS NOT NULL
                            AND length(CAST(content AS BLOB)) > 0
                      THEN 1 ELSE 0 END AS has_content,
                 CASE WHEN summary IS NOT NULL
                            AND length(CAST(summary AS BLOB)) > 0
                      THEN 1 ELSE 0 END AS has_summary,
                 COALESCE(hidden, 0) AS hidden,
                 COALESCE(rejected, 0) AS rejected,
                 COALESCE(thumbs_down, 0) AS thumbs_down,
                 author, categories,
                 ${supportsExternalUrl ? 'external_url' : "'' AS external_url"}
          FROM articles WHERE feed_id = ?
        `,
      )
      .all(feedId) as ExistingArticle[];
    const readExistingContent = db.prepare(
      'SELECT content FROM articles WHERE id = ?',
    );
    const existingByUrl = new Map<string, ExistingArticle>();
    const existingByGuid = new Map<string, ExistingArticle>();
    const existingById = new Map<string, ExistingArticle>();
    for (const row of existingRows) {
      existingById.set(row.id, row);
      const normalizedExistingUrl = normalizeArticleUrl(row.url);
      if (normalizedExistingUrl && !existingByUrl.has(normalizedExistingUrl)) {
        existingByUrl.set(normalizedExistingUrl, row);
      }
      const guid = normalizeGuid(row.guid || undefined);
      if (guid && !existingByGuid.has(guid)) existingByGuid.set(guid, row);
    }

    const seenInFetch = new Set<string>();
    for (const item of fetchResult.items) {
      // Skip items without URL
      if (!item.url) continue;

      const normalizedUrl = normalizeArticleUrl(item.url);
      const guid = normalizeGuid(item.guid);
      const articleId = generateArticleId(
        feedId,
        normalizedUrl,
        item.title,
        guid,
      );
      const legacyId = legacyArticleId(item.url, item.title, guid);
      const urlIdentity = normalizedUrl ? `url:${normalizedUrl}` : '';
      const guidIdentity = guid ? `guid:${guid}` : '';

      if (
        (urlIdentity && seenInFetch.has(urlIdentity)) ||
        (guidIdentity && seenInFetch.has(guidIdentity))
      ) {
        continue;
      }
      if (urlIdentity) seenInFetch.add(urlIdentity);
      if (guidIdentity) seenInFetch.add(guidIdentity);

      // Skip duplicate or update missing data. Prefer canonical URL and GUID
      // matches, then recognize IDs created by the previous global-GUID
      // strategy for backward compatibility. Never merge across feeds.
      const existing =
        existingByUrl.get(normalizedUrl) ||
        (guid ? existingByGuid.get(guid) : undefined) ||
        existingById.get(articleId) ||
        existingById.get(legacyId);
      if (existing) {
        let needsUpdate = false;
        let rankingInputChanged = false;
        const updates: string[] = [];
        const params: any[] = [];

        if (existing.url !== normalizedUrl) {
          const urlCollision = db
            .prepare(
              'SELECT id FROM articles WHERE feed_id = ? AND url = ? AND id != ?',
            )
            .get(feedId, normalizedUrl, existing.id) as
            { id: string } | undefined;
          if (!urlCollision) {
            updates.push('url = ?');
            params.push(normalizedUrl);
            needsUpdate = true;
          }
        }

        if (!existing.guid && guid) {
          updates.push('guid = ?');
          params.push(guid);
          needsUpdate = true;
        }

        if ((!existing.title || existing.title === 'Untitled') && item.title) {
          updates.push('title = ?');
          params.push(item.title);
          needsUpdate = true;
          rankingInputChanged = true;
        }

        if (!existing.author && item.author) {
          updates.push('author = ?');
          params.push(item.author);
          needsUpdate = true;
          rankingInputChanged = true;
        }

        const newLen = item.content?.length || 0;
        let shouldUpgradeContent = false;
        if (newLen > 0 && !existing.has_content) {
          shouldUpgradeContent = true;
        } else if (newLen > Number(existing.content_length_lower || 0) + 50) {
          const upperLength = Number(existing.content_length_upper || 0);
          if (newLen > upperLength + 50) {
            shouldUpgradeContent = true;
          } else {
            // SQLite counts code points or bytes. Read the body only when
            // those bounds disagree about the JavaScript UTF-16 threshold.
            const exactRow = readExistingContent.get(existing.id) as
              { content: string | null } | undefined;
            const exactLength = exactRow?.content?.length || 0;
            shouldUpgradeContent = newLen > exactLength + 50;
          }
        }

        if (
          !shouldUpgradeContent &&
          newLen > 0 &&
          newLen !== existing.content_length_lower &&
          hasArticleAnalysisText(null, item.content)
        ) {
          const stored = readExistingContent.get(existing.id) as
            { content: string | null } | undefined;
          shouldUpgradeContent = !hasArticleAnalysisText(null, stored?.content);
        }

        const addsSummary = !existing.has_summary && Boolean(item.summary);
        if (addsSummary && !shouldUpgradeContent) {
          updates.push('summary = ?');
          params.push(item.summary);
          needsUpdate = true;
          rankingInputChanged = true;
        }

        if (!existing.categories && item.categories.length > 0) {
          updates.push('categories = ?');
          params.push(JSON.stringify(item.categories));
          needsUpdate = true;
          rankingInputChanged = true;
        }

        if (!existing.image_url && item.imageUrl) {
          updates.push('image_url = ?');
          params.push(item.imageUrl);
          needsUpdate = true;
        }

        if (supportsExternalUrl && !existing.external_url && item.externalUrl) {
          updates.push('external_url = ?');
          params.push(item.externalUrl);
          needsUpdate = true;
        }

        // If the new content is significantly longer, it is likely a
        // transition from a snippet to full content.
        if (shouldUpgradeContent) {
          updates.push('content = ?');
          params.push(item.content);
          if (item.summary) {
            updates.push('summary = ?');
            params.push(item.summary);
          }
          needsUpdate = true;
          rankingInputChanged = true;
        }

        if (needsUpdate) {
          params.push(existing.id);
          db.prepare(
            `UPDATE articles SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`,
          ).run(...params.slice(0, -1), Date.now(), params.at(-1));
        }

        const existingVisible =
          !existing.hidden && !existing.rejected && !existing.thumbs_down;

        if (rankingInputChanged) {
          db.prepare(
            `UPDATE articles
             SET jev_score = NULL, jev_processed_at = NULL, jev_error = ''
             WHERE id = ?`,
          ).run(existing.id);
          db.prepare(
            `DELETE FROM jobs
             WHERE type = 'jev_process' AND status != 'processing'
               AND json_valid(payload) = 1
               AND json_extract(payload, '$.articleId') = ?`,
          ).run(existing.id);
          if (queueAi) {
            db.prepare(
              `UPDATE article_ai_metadata
               SET analysis_status = 'pending', analysis_error = '', processed_at = NULL
               WHERE article_id = ?`,
            ).run(existing.id);
          }
          refreshCombinedScore(existing.id);
          if (existingVisible) rankingArticleIds.add(existing.id);
        }

        const shouldQueueAi =
          queueAi &&
          existingVisible &&
          rankingInputChanged &&
          (Boolean(existing.has_content) ||
            Boolean(existing.has_summary) ||
            hasArticleAnalysisText(item.summary, item.content));
        if (shouldQueueAi) {
          enqueueAiProcess(existing.id, { feedId });
          aiQueuedArticleIds.add(existing.id);
        }
        continue;
      }

      // Use fetch time for invalid or future publisher timestamps.
      const fetchedAt = Date.now();
      const publishedAt = item.publishedAt?.getTime();
      const storedPublishedAt =
        publishedAt != null &&
        Number.isFinite(publishedAt) &&
        publishedAt <= fetchedAt
          ? publishedAt
          : null;

      // Insert new article
      const articleColumns = supportsExternalUrl
        ? 'id, feed_id, guid, url, title, author, summary, content, image_url, external_url, categories, published_at, fetched_at, created_at, updated_at'
        : 'id, feed_id, guid, url, title, author, summary, content, image_url, categories, published_at, fetched_at, created_at, updated_at';
      const articleValues = supportsExternalUrl
        ? [
            articleId,
            feedId,
            item.guid || '',
            normalizedUrl,
            item.title,
            item.author || '',
            item.summary || '',
            item.content || '',
            item.imageUrl || '',
            item.externalUrl || '',
            JSON.stringify(item.categories),
            storedPublishedAt,
            fetchedAt,
            fetchedAt,
            fetchedAt,
          ]
        : [
            articleId,
            feedId,
            item.guid || '',
            normalizedUrl,
            item.title,
            item.author || '',
            item.summary || '',
            item.content || '',
            item.imageUrl || '',
            JSON.stringify(item.categories),
            storedPublishedAt,
            fetchedAt,
            fetchedAt,
            fetchedAt,
          ];
      db.prepare(
        `INSERT INTO articles (${articleColumns}) VALUES (${articleValues.map(() => '?').join(', ')})`,
      ).run(...articleValues);
      applyPreferenceModelToArticle(articleId);
      const visibility = db
        .prepare(
          'SELECT hidden, rejected, thumbs_down FROM articles WHERE id = ?',
        )
        .get(articleId) as
        { hidden: number; rejected: number; thumbs_down: number } | undefined;
      const isVisible =
        Boolean(visibility) &&
        !visibility?.hidden &&
        !visibility?.rejected &&
        !visibility?.thumbs_down;
      if (
        isVisible &&
        queueAi &&
        hasArticleAnalysisText(item.summary, item.content)
      ) {
        enqueueAiProcess(articleId, { feedId });
        aiQueuedArticleIds.add(articleId);
      }

      const newArticle = db
        .prepare('SELECT * FROM articles WHERE id = ?')
        .get(articleId) as Record<string, unknown> | undefined;
      if (newArticle) webhookArticles.push(newArticle);

      newArticleIds.push(articleId);
      if (isVisible) rankingArticleIds.add(articleId);
      const inserted: ExistingArticle = {
        id: articleId,
        url: normalizedUrl,
        guid: guid || null,
        title: item.title,
        image_url: item.imageUrl || null,
        content_length_lower: item.content?.length || 0,
        content_length_upper: item.content?.length || 0,
        has_content: item.content ? 1 : 0,
        has_summary: item.summary ? 1 : 0,
        hidden: visibility?.hidden ? 1 : 0,
        rejected: visibility?.rejected ? 1 : 0,
        thumbs_down: visibility?.thumbs_down ? 1 : 0,
        author: item.author || null,
        categories: item.categories.length
          ? JSON.stringify(item.categories)
          : null,
        external_url: item.externalUrl || null,
      };
      existingById.set(articleId, inserted);
      existingByUrl.set(normalizedUrl, inserted);
      if (guid) existingByGuid.set(guid, inserted);
      articlesNew++;
    }

    // Update fetch log
    db.prepare(
      'UPDATE feed_fetch_logs SET status = ?, articles_found = ?, articles_new = ?, completed_at = ? WHERE id = ?',
    ).run('success', fetchResult.items.length, articlesNew, Date.now(), logId);

    // Update feed status and adaptive polling info
    if (articlesNew > 0) {
      db.prepare(
        "UPDATE feeds SET last_fetch_status = 'success', error_count = 0, last_error = '', last_changed_at = ?, fetch_count_since_change = 0, updated_at = ? WHERE id = ?",
      ).run(Date.now(), Date.now(), feedId);
    } else {
      db.prepare(
        "UPDATE feeds SET last_fetch_status = 'success', error_count = 0, last_error = '', fetch_count_since_change = ?, updated_at = ? WHERE id = ?",
      ).run(
        (feedRecord?.fetch_count_since_change || 0) + 1,
        Date.now(),
        feedId,
      );
    }

    updates.push('updated_at = ?');
    values.push(Date.now(), feedId);
    db.prepare(`UPDATE feeds SET ${updates.join(', ')} WHERE id = ?`).run(
      ...values,
    );

    return articlesNew;
  });

  try {
    const articlesNew = ingestTx();

    for (const article of webhookArticles) {
      void dispatchWebhookEvent({
        type: 'article.ingested',
        timestamp: Date.now(),
        payload: { article },
      }).catch((error) => {
        recordAppError({
          source: 'feed.ingester.webhook',
          error,
          details: { feedId, articleId: article.id },
        });
      });
    }

    if (articlesNew > 0) {
      broadcast('new_articles', {
        feedId,
        count: articlesNew,
        articles: newArticleIds,
      });
    }

    // Articles with queued enrichment receive a fresh Jev judgment after the
    // enrichment job finishes. Ranking the raw stub first would score the
    // same article again immediately after enrichment.
    for (const articleId of rankingArticleIds) {
      if (aiQueuedArticleIds.has(articleId)) continue;
      try {
        enqueueJevProcess(articleId, { feedId });
      } catch (err) {
        recordAppError({
          source: 'feed.ingester.jev.enqueue',
          error: err,
          details: { articleId, feedId },
        });
      }
    }

    return {
      success: true,
      articlesFound: fetchResult.items.length,
      articlesNew,
      status: 'completed',
      feedTitle: fetchResult.title,
      feedDescription: fetchResult.description,
      feedLink: fetchResult.link,
      feedImageUrl: fetchResult.imageUrl,
    };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : 'Transaction failed';
    db.prepare(
      'UPDATE feed_fetch_logs SET status = ?, error_message = ?, completed_at = ? WHERE id = ?',
    ).run('error', errorMessage, Date.now(), logId);
    db.prepare(
      "UPDATE feeds SET last_fetch_status = 'error', last_error = ?, error_count = COALESCE(error_count, 0) + ?, updated_at = ? WHERE id = ?",
    ).run(
      errorMessage,
      options.countFailure === false ? 0 : 1,
      Date.now(),
      feedId,
    );
    recordAppError({
      source: 'feed.ingester.transaction',
      error: err,
      details: { feedId, sourceType },
    });
    return {
      success: false,
      articlesFound: 0,
      articlesNew: 0,
      error: errorMessage,
    };
  }
}
