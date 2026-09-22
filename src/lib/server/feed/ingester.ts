import { getDb } from '$lib/server/db';
import { fetchFeed } from '$lib/server/feed/fetcher';
import {
  isRedditUrl,
  normalizeRedditUrl,
  fetchRedditSource,
} from '$lib/server/sources/reddit';
import { applyPreferenceModelToArticle } from '$lib/server/preferences';
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
}

interface IngestResult {
  success: boolean;
  articlesFound: number;
  articlesNew: number;
  skipped?: boolean;
  status?: 'completed' | 'already_running';
  error?: string;
  feedTitle?: string;
  feedDescription?: string;
  feedLink?: string;
  feedImageUrl?: string;
}

export function normalizeArticleUrl(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value.trim());
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (url.protocol === 'http:' && url.port === '80') url.port = '';
    if (url.protocol === 'https:' && url.port === '443') url.port = '';

    for (const key of [...url.searchParams.keys()]) {
      if (
        /^utm_/i.test(key) ||
        ['fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid'].includes(
          key.toLowerCase(),
        )
      ) {
        url.searchParams.delete(key);
      }
    }

    const sortedParams = [...url.searchParams.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    url.search = '';
    for (const [key, val] of sortedParams) url.searchParams.append(key, val);

    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.href;
  } catch {
    return value.trim();
  }
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
      "UPDATE feeds SET last_fetch_status = 'error', last_error = ?, error_count = COALESCE(error_count, 0) + 1, updated_at = ? WHERE id = ?",
    ).run(fetchResult.error || 'Unknown error', Date.now(), feedId);
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
    };
  }

  // Update feed metadata
  const updates: string[] = [];
  const values: (string | number)[] = [];
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

  // Cache headers
  if (fetchResult.etag) {
    updates.push('etag = ?');
    values.push(fetchResult.etag);
  }
  if (fetchResult.lastModified) {
    updates.push('last_modified_header = ?');
    values.push(fetchResult.lastModified);
  }

  if (updates.length > 0) {
    updates.push('updated_at = ?');
    values.push(Date.now());
    values.push(feedId);
    db.prepare(`UPDATE feeds SET ${updates.join(', ')} WHERE id = ?`).run(
      ...values,
    );
  }

  // Process articles in a transaction for atomicity
  const newArticleIds: string[] = [];
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
      content: string | null;
      summary: string | null;
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
          SELECT id, url, guid, title, image_url, content, summary, author,
                 categories, ${supportsExternalUrl ? 'external_url' : "'' AS external_url"}
          FROM articles WHERE feed_id = ?
        `,
      )
      .all(feedId) as ExistingArticle[];
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
        }

        if (!existing.author && item.author) {
          updates.push('author = ?');
          params.push(item.author);
          needsUpdate = true;
        }

        const currentLen = existing.content?.length || 0;
        const newLen = item.content?.length || 0;
        const shouldUpgradeContent =
          newLen > currentLen + 50 || (newLen > 0 && !existing.content);

        if (!existing.summary && item.summary && !shouldUpgradeContent) {
          updates.push('summary = ?');
          params.push(item.summary);
          needsUpdate = true;
        }

        if (!existing.categories && item.categories.length > 0) {
          updates.push('categories = ?');
          params.push(JSON.stringify(item.categories));
          needsUpdate = true;
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
        }

        if (needsUpdate) {
          params.push(existing.id);
          db.prepare(
            `UPDATE articles SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`,
          ).run(...params.slice(0, -1), Date.now(), params.at(-1));
        }
        continue;
      }

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
            item.publishedAt ? item.publishedAt.getTime() : null,
            Date.now(),
            Date.now(),
            Date.now(),
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
            item.publishedAt ? item.publishedAt.getTime() : null,
            Date.now(),
            Date.now(),
            Date.now(),
          ];
      db.prepare(
        `INSERT INTO articles (${articleColumns}) VALUES (${articleValues.map(() => '?').join(', ')})`,
      ).run(...articleValues);
      applyPreferenceModelToArticle(articleId);

      // Trigger webhook for new article
      const newArticle = db
        .prepare('SELECT * FROM articles WHERE id = ?')
        .get(articleId) as any;
      if (newArticle) {
        dispatchWebhookEvent({
          type: 'article.ingested',
          timestamp: Date.now(),
          payload: { article: newArticle },
        });
      }

      newArticleIds.push(articleId);
      const inserted: ExistingArticle = {
        id: articleId,
        url: normalizedUrl,
        guid: guid || null,
        title: item.title,
        image_url: item.imageUrl || null,
        content: item.content || null,
        summary: item.summary || null,
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

    return articlesNew;
  });

  try {
    const articlesNew = ingestTx();

    if (articlesNew > 0) {
      broadcast('new_articles', {
        feedId,
        count: articlesNew,
        articles: newArticleIds,
      });
    }

    // AI work is durable now. The worker can retry it after provider errors or
    // a process restart instead of losing the fire-and-forget promise.
    for (const articleId of newArticleIds) {
      try {
        enqueueAiProcess(articleId, { feedId });
      } catch (err) {
        recordAppError({
          source: 'feed.ingester.ai.enqueue',
          error: err,
          details: { articleId, feedId },
        });
      }
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
      "UPDATE feeds SET last_fetch_status = 'error', last_error = ?, error_count = COALESCE(error_count, 0) + 1, updated_at = ? WHERE id = ?",
    ).run(errorMessage, Date.now(), feedId);
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
