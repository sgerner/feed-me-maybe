import { isAiProcessingConfigured } from '#lib/server/ai/runtime.ts';
import { hasArticleAnalysisText } from '#lib/server/ai/prompts.ts';
import { normalizeSourceUrl } from '#lib/server/source-url.ts';
import { getDb } from '#lib/server/db/index.ts';
import {
  fetchFeed,
  type FetchResult,
  type FetchedItem,
  type RawFetchedBodies,
} from '#lib/server/feed/fetcher.ts';

const RAW_FETCHED_BODIES = Symbol.for('feed-me-maybe.raw-fetched-bodies');

function getRawFetchedItemBodies(
  item: FetchedItem,
): RawFetchedBodies | undefined {
  return (item as FetchedItem & { [RAW_FETCHED_BODIES]?: RawFetchedBodies })[
    RAW_FETCHED_BODIES
  ];
}
import { SafeFetchError } from '#lib/server/network.ts';
import {
  isRedditUrl,
  normalizeRedditUrl,
  fetchRedditSource,
} from '#lib/server/sources/reddit.ts';
import {
  applyPreferenceModelToArticle,
  updateHeuristicScore,
} from '#lib/server/preferences.ts';
import { parseJsonTextArray, stripHtml } from '#lib/server/normalization.ts';
import { refreshCombinedScore } from '#lib/server/scoring.ts';
import { dispatchWebhookEvent } from '#lib/server/webhooks.ts';
import { broadcast } from '#lib/server/realtime.ts';
import { getConfiguredProxyBaseUrl } from '#lib/server/proxy.ts';
import { recordAppError } from '#lib/server/logging.ts';
import {
  enqueueAiProcess,
  enqueueJevProcess,
} from '#lib/server/feed/job-queue.ts';
import { normalizeFeedUrl } from '#lib/server/feed-management.ts';
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
      'SELECT url, enabled, etag, last_modified_header, fetch_count_since_change, custom_title, source_type, source_metadata, use_proxy FROM feeds WHERE id = ?',
    )
    .get(feedId) as
    | {
        url: string;
        enabled: number | null;
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

  if (!feedRecord.enabled) {
    return {
      success: true,
      articlesFound: 0,
      articlesNew: 0,
      skipped: true,
      status: 'completed',
      error: 'Feed is disabled',
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
  try {
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

    let fetchResult: Awaited<ReturnType<typeof fetchFeed>>;
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
      .prepare('SELECT url, enabled FROM feeds WHERE id = ?')
      .get(feedId) as { url: string; enabled: number | null } | undefined;
    if (!current || !current.enabled || current.url !== feedRecord.url) {
      db.prepare(
        'UPDATE feed_fetch_logs SET status = ?, completed_at = ? WHERE id = ?',
      ).run('success', Date.now(), logId);
      return {
        success: true,
        articlesFound: 0,
        articlesNew: 0,
        ...(!current?.enabled ? { skipped: true } : {}),
        status: 'completed',
      };
    }

    if (sourceType === 'reddit') {
      const normalizedUrl = normalizeRedditUrl(canonicalUrl).normalizedUrl;
      if (feedRecord.url !== normalizedUrl) {
        const duplicateFeed = db
          .prepare('SELECT id FROM feeds WHERE url = ? AND id != ?')
          .get(normalizedUrl, feedId) as { id: string } | undefined;
        if (!duplicateFeed) {
          db.prepare(
            'UPDATE feeds SET url = ?, updated_at = ? WHERE id = ?',
          ).run(normalizedUrl, Date.now(), feedId);
        }
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
      ).run(
        (feedRecord?.fetch_count_since_change || 0) + 1,
        Date.now(),
        feedId,
      );
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
        permanentFailure: Boolean(
          fetchResult.permanentFailure || fetchResult.httpStatus === 410,
        ),
      };
    }

    return commitFetchedFeedResult({
      feedId,
      fetchResult,
      logId,
      customTitle: Boolean(feedRecord?.custom_title),
      fetchCountSinceChange: feedRecord?.fetch_count_since_change || 0,
    });
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : 'Feed ingestion failed';
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
      ...(err instanceof SafeFetchError && err.code !== 'dns_failure'
        ? { permanentFailure: true }
        : {}),
    };
  }
}

export function commitFetchedFeedResult(options: {
  feedId: string;
  fetchResult: FetchResult;
  logId?: string | null;
  startedAt?: number;
  customTitle?: boolean;
  fetchCountSinceChange?: number;
}): IngestResult {
  const db = getDb();
  const { feedId, fetchResult } = options;
  const startedAt = options.startedAt ?? Date.now();

  const updates: string[] = [];
  const values: (string | number | null)[] = [];
  if (fetchResult.title && !options.customTitle) {
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

  const newArticleIds: string[] = [];
  const webhookArticles: Record<string, unknown>[] = [];
  const aiQueuedArticleIds = new Set<string>();
  const rankingArticleIds = new Set<string>();
  const queueAi = fetchResult.items.length > 0 && isAiProcessingConfigured();
  const supportsExternalUrl = hasArticleColumn('external_url');

  const ingestTx = db.transaction(() => {
    const logId = options.logId ?? crypto.randomUUID();
    if (!options.logId) {
      db.prepare(
        'INSERT INTO feed_fetch_logs (id, feed_id, status, started_at, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(logId, feedId, 'fetching', startedAt, startedAt);
    }

    let articlesNew = 0;
    const batchFetchedAt = Date.now();
    type ExistingArticle = {
      id: string;
      url: string;
      guid: string | null;
      title: string | null;
      summary: string | null;
      image_url: string | null;
      content_length_lower: number | null;
      content_length_upper: number | null;
      has_content: number;
      has_summary: number;
      read: number;
      saved: number;
      hidden: number;
      rejected: number;
      thumbs_down: number;
      author: string | null;
      categories: string | null;
      external_url: string | null;
    };

    const existingRows = db
      .prepare(
        `
          SELECT id, url, guid, title, summary, image_url,
                 length(content) AS content_length_lower,
                 length(CAST(content AS BLOB)) AS content_length_upper,
                 CASE WHEN content IS NOT NULL
                            AND length(CAST(content AS BLOB)) > 0
                      THEN 1 ELSE 0 END AS has_content,
                 CASE WHEN summary IS NOT NULL
                            AND length(CAST(summary AS BLOB)) > 0
                      THEN 1 ELSE 0 END AS has_summary,
                 COALESCE(read, 0) AS read,
                 COALESCE(saved, 0) AS saved,
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
    const existingByUrl = new Map<string, ExistingArticle[]>();
    const existingByGuid = new Map<string, ExistingArticle>();
    const existingById = new Map<string, ExistingArticle>();
    const addToUrlIndex = (normalizedUrl: string, row: ExistingArticle) => {
      if (!normalizedUrl) return;
      const list = existingByUrl.get(normalizedUrl);
      if (list) {
        if (!list.includes(row)) list.push(row);
      } else {
        existingByUrl.set(normalizedUrl, [row]);
      }
    };
    const removeFromUrlIndex = (
      normalizedUrl: string,
      row: ExistingArticle,
    ) => {
      if (!normalizedUrl) return;
      const list = existingByUrl.get(normalizedUrl);
      if (!list) return;
      const next = list.filter((candidate) => candidate !== row);
      if (next.length) existingByUrl.set(normalizedUrl, next);
      else existingByUrl.delete(normalizedUrl);
    };

    for (const row of existingRows) {
      existingById.set(row.id, row);
      addToUrlIndex(normalizeArticleUrl(row.url), row);
      const guid = normalizeGuid(row.guid || undefined);
      if (guid && !existingByGuid.has(guid)) existingByGuid.set(guid, row);
    }

    const guidToUrls = new Map<string, Set<string>>();
    for (const item of fetchResult.items) {
      if (!item.url) continue;
      const rawGuid = normalizeGuid(item.guid);
      const normalizedUrl = normalizeArticleUrl(item.url);
      if (!rawGuid || !normalizedUrl) continue;
      let urls = guidToUrls.get(rawGuid);
      if (!urls) {
        urls = new Set();
        guidToUrls.set(rawGuid, urls);
      }
      urls.add(normalizedUrl);
    }
    const nonUniqueGuids = new Set<string>();
    for (const [candidateGuid, urls] of guidToUrls) {
      if (urls.size > 1) nonUniqueGuids.add(candidateGuid);
    }

    type PreparedItem = {
      item: (typeof fetchResult.items)[number];
      itemIndex: number;
      normalizedUrl: string;
      guid: string;
      articleId: string;
      legacyId: string;
    };

    const seenGuidsInFetch = new Set<string>();
    const preparedItems: PreparedItem[] = [];
    for (let itemIndex = 0; itemIndex < fetchResult.items.length; itemIndex++) {
      const item = fetchResult.items[itemIndex];
      if (!item.url) continue;
      const normalizedUrl = normalizeArticleUrl(item.url);
      const rawGuid = normalizeGuid(item.guid);
      const guid = rawGuid && !nonUniqueGuids.has(rawGuid) ? rawGuid : '';
      if (guid) {
        if (seenGuidsInFetch.has(guid)) continue;
        seenGuidsInFetch.add(guid);
      }
      const articleId = generateArticleId(
        feedId,
        normalizedUrl,
        item.title,
        guid,
      );
      const legacyId = legacyArticleId(item.url, item.title, guid);
      preparedItems.push({
        item,
        itemIndex,
        normalizedUrl,
        guid,
        articleId,
        legacyId,
      });
    }

    const titlesMatch = (a: string | null | undefined, b: string | undefined) =>
      (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

    const findUrlMatch = (
      normalizedUrl: string,
      title: string,
      guid: string,
    ): ExistingArticle | undefined => {
      const candidates = existingByUrl.get(normalizedUrl);
      if (!candidates?.length) return undefined;
      if (guid) {
        return (
          candidates.find(
            (candidate) =>
              !normalizeGuid(candidate.guid || undefined) &&
              titlesMatch(candidate.title, title),
          ) ||
          candidates.find(
            (candidate) =>
              normalizeGuid(candidate.guid || undefined) !== guid &&
              titlesMatch(candidate.title, title),
          )
        );
      }
      return (
        candidates.find(
          (candidate) => !normalizeGuid(candidate.guid || undefined),
        ) || candidates.find((candidate) => titlesMatch(candidate.title, title))
      );
    };

    const reconcileExisting = (
      existing: ExistingArticle,
      prepared: PreparedItem,
    ) => {
      const { item, normalizedUrl, guid } = prepared;
      const rawBodies = getRawFetchedItemBodies(item);
      let needsUpdate = false;
      let rankingInputChanged = false;
      const articleUpdates: string[] = [];
      const params: unknown[] = [];

      const effectiveGuid = normalizeGuid(existing.guid || undefined) || guid;
      if (existing.url !== normalizedUrl) {
        const urlCollision = effectiveGuid
          ? undefined
          : (db
              .prepare(
                "SELECT id FROM articles WHERE feed_id = ? AND url = ? AND id != ? AND (guid IS NULL OR guid = '')",
              )
              .get(feedId, normalizedUrl, existing.id) as
              { id: string } | undefined);
        if (!urlCollision) {
          const oldNormalizedUrl = normalizeArticleUrl(existing.url);
          articleUpdates.push('url = ?');
          params.push(normalizedUrl);
          needsUpdate = true;
          removeFromUrlIndex(oldNormalizedUrl, existing);
          existing.url = normalizedUrl;
          addToUrlIndex(normalizedUrl, existing);
        }
      }

      if (!normalizeGuid(existing.guid || undefined) && guid) {
        articleUpdates.push('guid = ?');
        params.push(guid);
        needsUpdate = true;
        existing.guid = guid;
        existingByGuid.set(guid, existing);
      }

      const isPopulatedGuidMatch =
        Boolean(guid) && normalizeGuid(existing.guid || undefined) === guid;

      if (
        ((!existing.title || existing.title === 'Untitled') && item.title) ||
        (isPopulatedGuidMatch &&
          Boolean(item.title) &&
          item.title !== existing.title)
      ) {
        articleUpdates.push('title = ?');
        params.push(item.title);
        existing.title = item.title;
        needsUpdate = true;
        rankingInputChanged = true;
      }

      if (!existing.author && item.author) {
        articleUpdates.push('author = ?');
        params.push(item.author);
        existing.author = item.author;
        needsUpdate = true;
        rankingInputChanged = true;
      }

      let shouldUpgradeContent = false;
      const hasCandidateContent = rawBodies
        ? Boolean(rawBodies.rawContent)
        : Boolean(item.content);
      if (hasCandidateContent && !(existing.saved && existing.has_content)) {
        if (!existing.has_content) {
          const newLen = item.content?.length || 0;
          shouldUpgradeContent = newLen > 0;
        } else {
          const lowerLength = Number(existing.content_length_lower || 0);
          const upperLength = Number(existing.content_length_upper || 0);
          const candidateRaw = rawBodies ? rawBodies.rawContent : item.content!;
          const tagCount = rawBodies
            ? candidateRaw.match(/<(?:a|img|source)\b/gi)?.length || 0
            : 0;
          const maxPossibleLen = rawBodies
            ? candidateRaw.length +
              tagCount * (rawBodies.contentBase.length + 50)
            : candidateRaw.length;

          let storedContent: string | null | undefined;
          const getStoredContent = () => {
            if (storedContent === undefined) {
              const row = readExistingContent.get(existing.id) as
                { content: string | null } | undefined;
              storedContent = row?.content ?? null;
            }
            return storedContent;
          };

          if (maxPossibleLen > lowerLength + 50) {
            const newContent = item.content || '';
            const newLen = newContent.length;
            let exceedsLengthThreshold = false;
            if (newLen > upperLength + 50) {
              exceedsLengthThreshold = true;
            } else if (newLen > lowerLength + 50) {
              const exactLength = getStoredContent()?.length || 0;
              exceedsLengthThreshold = newLen > exactLength + 50;
            }
            if (exceedsLengthThreshold) {
              const existingTextLen = stripHtml(
                getStoredContent() || '',
              ).length;
              const newTextLen = stripHtml(newContent).length;
              shouldUpgradeContent =
                newTextLen > existingTextLen || existingTextLen === 0;
            }
          }

          if (
            !shouldUpgradeContent &&
            candidateRaw.length !== lowerLength &&
            hasArticleAnalysisText(null, candidateRaw)
          ) {
            const existingBody = getStoredContent();
            if (!hasArticleAnalysisText(null, existingBody)) {
              const newContent = item.content || '';
              shouldUpgradeContent =
                newContent.length > 0 &&
                newContent.length !== lowerLength &&
                hasArticleAnalysisText(null, newContent);
            }
          }
        }
      }

      const rawSummaryCandidate = rawBodies ? rawBodies.rawSummary : undefined;
      const mayNeedSummary =
        !shouldUpgradeContent &&
        (!existing.has_summary
          ? Boolean(rawBodies ? rawSummaryCandidate : item.summary)
          : isPopulatedGuidMatch &&
            Boolean(rawBodies ? rawSummaryCandidate : item.summary) &&
            (!rawBodies ||
              (rawSummaryCandidate !== (existing.summary || '') &&
                stripHtml(rawSummaryCandidate || '')
                  .slice(0, 500)
                  .trim() !==
                  stripHtml(existing.summary || '')
                    .slice(0, 500)
                    .trim())));

      if (mayNeedSummary) {
        const sanitizedSummary = item.summary;
        const addsSummary = !existing.has_summary && Boolean(sanitizedSummary);
        const updatesGuidSummary =
          isPopulatedGuidMatch &&
          Boolean(sanitizedSummary) &&
          sanitizedSummary !== (existing.summary || '');
        if (addsSummary || updatesGuidSummary) {
          articleUpdates.push('summary = ?');
          params.push(sanitizedSummary);
          existing.summary = sanitizedSummary || '';
          existing.has_summary = 1;
          needsUpdate = true;
          rankingInputChanged = true;
        }
      }

      const hasExistingCategories =
        parseJsonTextArray(existing.categories).length > 0;
      if (!hasExistingCategories && item.categories.length > 0) {
        const serializedCategories = JSON.stringify(item.categories);
        articleUpdates.push('categories = ?');
        params.push(serializedCategories);
        existing.categories = serializedCategories;
        needsUpdate = true;
        rankingInputChanged = true;
      }

      if (!existing.image_url && item.imageUrl) {
        articleUpdates.push('image_url = ?');
        params.push(item.imageUrl);
        existing.image_url = item.imageUrl;
        needsUpdate = true;
      }

      if (supportsExternalUrl && !existing.external_url && item.externalUrl) {
        articleUpdates.push('external_url = ?');
        params.push(item.externalUrl);
        existing.external_url = item.externalUrl;
        needsUpdate = true;
      }

      if (shouldUpgradeContent) {
        const upgradedContent = item.content;
        articleUpdates.push('content = ?');
        params.push(upgradedContent);
        existing.has_content = upgradedContent ? 1 : 0;
        existing.content_length_lower = upgradedContent?.length || 0;
        existing.content_length_upper = upgradedContent?.length || 0;
        const upgradedSummary = item.summary;
        if (upgradedSummary) {
          articleUpdates.push('summary = ?');
          params.push(upgradedSummary);
          existing.summary = upgradedSummary;
          existing.has_summary = 1;
        }
        needsUpdate = true;
        rankingInputChanged = true;
      }

      if (needsUpdate) {
        params.push(existing.id);
        db.prepare(
          `UPDATE articles SET ${articleUpdates.join(', ')}, updated_at = ? WHERE id = ?`,
        ).run(...params.slice(0, -1), Date.now(), params.at(-1));
      }

      let existingVisible =
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
        if (
          shouldUpgradeContent &&
          existingVisible &&
          !existing.read &&
          !existing.saved
        ) {
          applyPreferenceModelToArticle(existing.id);
          const refreshedVisibility = db
            .prepare(
              'SELECT hidden, rejected, thumbs_down FROM articles WHERE id = ?',
            )
            .get(existing.id) as
            | { hidden: number; rejected: number; thumbs_down: number }
            | undefined;
          existingVisible =
            Boolean(refreshedVisibility) &&
            !refreshedVisibility?.hidden &&
            !refreshedVisibility?.rejected &&
            !refreshedVisibility?.thumbs_down;
          existing.hidden = refreshedVisibility?.hidden ? 1 : 0;
          existing.rejected = refreshedVisibility?.rejected ? 1 : 0;
          existing.thumbs_down = refreshedVisibility?.thumbs_down ? 1 : 0;
        }
        updateHeuristicScore(existing.id);
        refreshCombinedScore(existing.id);
        if (existingVisible) rankingArticleIds.add(existing.id);
      }

      const shouldQueueAi =
        queueAi &&
        existingVisible &&
        rankingInputChanged &&
        (Boolean(existing.has_content) ||
          Boolean(existing.has_summary) ||
          hasArticleAnalysisText(
            rawBodies ? rawBodies.rawSummary : item.summary,
            rawBodies ? rawBodies.rawContent : item.content,
          ));
      if (shouldQueueAi) {
        enqueueAiProcess(existing.id, { feedId });
        aiQueuedArticleIds.add(existing.id);
      }
    };

    const deferredItems: PreparedItem[] = [];
    for (const prepared of preparedItems) {
      if (!prepared.guid) {
        deferredItems.push(prepared);
        continue;
      }
      const guidMatch =
        existingByGuid.get(prepared.guid) ||
        existingById.get(prepared.articleId) ||
        existingById.get(prepared.legacyId);
      if (guidMatch) {
        reconcileExisting(guidMatch, prepared);
      } else {
        deferredItems.push(prepared);
      }
    }

    for (const prepared of deferredItems) {
      const { item, itemIndex, normalizedUrl, guid, articleId, legacyId } =
        prepared;
      const existing =
        findUrlMatch(normalizedUrl, item.title, guid) ||
        existingById.get(articleId) ||
        existingById.get(legacyId);
      if (existing) {
        reconcileExisting(existing, prepared);
        continue;
      }

      const fetchedAt = batchFetchedAt - itemIndex;
      const publishedAt = item.publishedAt?.getTime();
      const storedPublishedAt =
        publishedAt != null &&
        Number.isFinite(publishedAt) &&
        publishedAt <= batchFetchedAt
          ? publishedAt
          : null;

      const sanitizedSummary = item.summary || '';
      const sanitizedContent = item.content || '';

      const articleColumns = supportsExternalUrl
        ? 'id, feed_id, guid, url, title, author, summary, content, image_url, external_url, categories, published_at, fetched_at, created_at, updated_at'
        : 'id, feed_id, guid, url, title, author, summary, content, image_url, categories, published_at, fetched_at, created_at, updated_at';
      const articleValues = supportsExternalUrl
        ? [
            articleId,
            feedId,
            guid,
            normalizedUrl,
            item.title,
            item.author || '',
            sanitizedSummary,
            sanitizedContent,
            item.imageUrl || '',
            item.externalUrl || '',
            JSON.stringify(item.categories),
            storedPublishedAt,
            fetchedAt,
            batchFetchedAt,
            batchFetchedAt,
          ]
        : [
            articleId,
            feedId,
            guid,
            normalizedUrl,
            item.title,
            item.author || '',
            sanitizedSummary,
            sanitizedContent,
            item.imageUrl || '',
            JSON.stringify(item.categories),
            storedPublishedAt,
            fetchedAt,
            batchFetchedAt,
            batchFetchedAt,
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
        hasArticleAnalysisText(sanitizedSummary, sanitizedContent)
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
        summary: sanitizedSummary || null,
        image_url: item.imageUrl || null,
        content_length_lower: sanitizedContent.length,
        content_length_upper: sanitizedContent.length,
        has_content: sanitizedContent ? 1 : 0,
        has_summary: sanitizedSummary ? 1 : 0,
        read: 0,
        saved: 0,
        hidden: visibility?.hidden ? 1 : 0,
        rejected: visibility?.rejected ? 1 : 0,
        thumbs_down: visibility?.thumbs_down ? 1 : 0,
        author: item.author || null,
        categories: item.categories.length
          ? JSON.stringify(item.categories)
          : '[]',
        external_url: item.externalUrl || null,
      };
      existingById.set(articleId, inserted);
      addToUrlIndex(normalizedUrl, inserted);
      if (guid) existingByGuid.set(guid, inserted);
      articlesNew++;
    }

    const completedAt = Date.now();
    db.prepare(
      'UPDATE feed_fetch_logs SET status = ?, articles_found = ?, articles_new = ?, completed_at = ? WHERE id = ?',
    ).run('success', fetchResult.items.length, articlesNew, completedAt, logId);

    if (articlesNew > 0) {
      db.prepare(
        "UPDATE feeds SET last_fetch_status = 'success', last_fetch_at = COALESCE(last_fetch_at, ?), error_count = 0, last_error = '', last_changed_at = ?, fetch_count_since_change = 0, updated_at = ? WHERE id = ?",
      ).run(startedAt, completedAt, completedAt, feedId);
    } else {
      db.prepare(
        "UPDATE feeds SET last_fetch_status = 'success', last_fetch_at = COALESCE(last_fetch_at, ?), error_count = 0, last_error = '', fetch_count_since_change = ?, updated_at = ? WHERE id = ?",
      ).run(
        startedAt,
        (options.fetchCountSinceChange || 0) + 1,
        completedAt,
        feedId,
      );
    }

    updates.push('updated_at = ?');
    values.push(completedAt, feedId);
    db.prepare(`UPDATE feeds SET ${updates.join(', ')} WHERE id = ?`).run(
      ...values,
    );

    return articlesNew;
  });

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
}
