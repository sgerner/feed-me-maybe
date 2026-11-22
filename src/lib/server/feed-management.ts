import { normalizeFeedSourceUrl } from '#lib/server/source-url.ts';
import { getDb } from '#lib/server/db/index.ts';
import { fetchFeed, type FetchResult } from '#lib/server/feed/fetcher.ts';
import {
  fetchRedditSource,
  isRedditUrl,
  normalizeRedditUrl,
  type RedditNormalizedSource,
} from '#lib/server/sources/reddit.ts';
import {
  cancelQueuedWorkForClearedArticles,
  enqueueFeedFetch,
  isClaimableFeedFetchJob,
  runDueJobs,
  type JobRecord,
} from '#lib/server/feed/job-queue.ts';
import { recordAppError } from '#lib/server/logging.ts';
import { scheduleNextPoll, wakePoller } from '#lib/server/poller.ts';
import { readJsonObject } from '#lib/server/request-body.ts';

const MIN_POLL_INTERVAL_MINS = 1;
const MAX_POLL_INTERVAL_MINS = 24 * 60;
const DISCOVERY_OVERALL_TIMEOUT_MS = 30_000;
const DISCOVERY_ATTEMPT_TIMEOUT_MS = 15_000;

export type FeedHealthStatus =
  'healthy' | 'queued' | 'stale' | 'error' | 'fetching' | 'never' | 'disabled';

export type FeedHealth = {
  feedId: string;
  status: FeedHealthStatus;
  enabled: boolean;
  stale: boolean;
  ageMs: number | null;
  ageMins: number | null;
  effectivePollIntervalMins: number;
  staleAfterMins: number;
  nextDueAt: number | null;
  errorCount: number;
  recentErrorCount: number;
  lastFetchStatus: string;
  lastFetchAt: number | null;
  lastSuccessAt: number | null;
  lastError: string;
  activeJob: {
    id: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    scheduledAt: number | null;
    startedAt: number | null;
  } | null;
};

export type FeedFetchLogSummary = {
  id: string;
  feedId: string;
  status: string;
  articlesFound: number;
  articlesNew: number;
  errorMessage: string;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
};

type FeedHealthRow = {
  id: string;
  enabled: number | null;
  poll_interval_mins: number | null;
  fetch_count_since_change: number | null;
  error_count: number | null;
  last_fetch_status: string | null;
  last_fetch_at: number | null;
  last_error: string | null;
};

function parsePollInterval(
  value: number | null | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(
    MAX_POLL_INTERVAL_MINS,
    Math.max(MIN_POLL_INTERVAL_MINS, Math.floor(parsed)),
  );
}

export function normalizeFeedUrl(value: string): string {
  return normalizeFeedSourceUrl(value);
}
export function getGlobalPollIntervalMins(): number {
  try {
    const row = getDb()
      .prepare(
        "SELECT value FROM app_settings WHERE key = 'poll_interval_mins'",
      )
      .get() as { value: string } | undefined;
    return parsePollInterval(Number(row?.value), 15);
  } catch {
    return 15;
  }
}

export function getEffectivePollIntervalMins(
  feedInterval: number | null | undefined,
  fetchCountSinceChange: number | null | undefined,
  globalInterval = getGlobalPollIntervalMins(),
  errorCount = 0,
): number {
  let interval = parsePollInterval(feedInterval, globalInterval);
  const quietFetches = Math.max(0, Number(fetchCountSinceChange || 0));
  if (quietFetches > 10) interval *= 2;
  if (quietFetches > 50) interval *= 2;
  const failureMultiplier = 2 ** Math.min(6, Math.max(0, errorCount));
  return Math.min(MAX_POLL_INTERVAL_MINS, interval * failureMultiplier);
}

type GroupedFeedHealthRow = FeedHealthRow & {
  has_active_fetch: number | null;
  last_success_at: number | null;
  recent_error_count: number | null;
  job_id: string | null;
  job_status: string | null;
  job_attempts: number | null;
  job_max_attempts: number | null;
  job_scheduled_at: number | null;
  job_started_at: number | null;
};

const GROUPED_FEED_HEALTH_SELECT = `
  SELECT
    f.id,
    f.enabled,
    f.poll_interval_mins,
    f.fetch_count_since_change,
    f.error_count,
    f.last_fetch_status,
    f.last_fetch_at,
    f.last_error,
    COALESCE(l.has_active_fetch, 0) AS has_active_fetch,
    l.last_success_at,
    COALESCE(l.recent_error_count, 0) AS recent_error_count,
    j.job_id,
    j.job_status,
    j.job_attempts,
    j.job_max_attempts,
    j.job_scheduled_at,
    j.job_started_at
  FROM feeds f
  LEFT JOIN (
    SELECT
      feed_id,
      MAX(CASE WHEN status IN ('pending', 'fetching') THEN 1 ELSE 0 END) AS has_active_fetch,
      MAX(CASE WHEN status = 'success' THEN completed_at END) AS last_success_at,
      SUM(CASE WHEN status = 'error' AND created_at >= ? THEN 1 ELSE 0 END) AS recent_error_count
    FROM feed_fetch_logs
    GROUP BY feed_id
  ) l ON l.feed_id = f.id
  LEFT JOIN (
    SELECT
      feed_id,
      id AS job_id,
      status AS job_status,
      attempts AS job_attempts,
      max_attempts AS job_max_attempts,
      scheduled_at AS job_scheduled_at,
      started_at AS job_started_at
    FROM (
      SELECT
        json_extract(payload, '$.feedId') AS feed_id,
        id,
        status,
        attempts,
        max_attempts,
        scheduled_at,
        started_at,
        ROW_NUMBER() OVER (
          PARTITION BY json_extract(payload, '$.feedId')
          ORDER BY CASE status WHEN 'processing' THEN 0 ELSE 1 END, created_at ASC
        ) AS rn
      FROM jobs
      WHERE type = 'feed_fetch'
        AND status IN ('queued', 'processing')
        AND json_valid(payload) = 1
    )
    WHERE rn = 1
  ) j ON j.feed_id = f.id
`;

function buildFeedHealthFromRow(
  feed: GroupedFeedHealthRow,
  globalInterval: number,
  now: number,
): FeedHealth {
  const effectivePollIntervalMins = getEffectivePollIntervalMins(
    feed.poll_interval_mins,
    feed.fetch_count_since_change,
    globalInterval,
    feed.error_count ?? 0,
  );
  const staleAfterMins = Math.min(
    MAX_POLL_INTERVAL_MINS * 2,
    effectivePollIntervalMins * 2,
  );
  const ageMs =
    feed.last_fetch_at == null ? null : Math.max(0, now - feed.last_fetch_at);
  const ageMins = ageMs == null ? null : Math.floor(ageMs / 60_000);
  const stale =
    Boolean(feed.enabled) &&
    (feed.last_fetch_at == null ||
      ageMs == null ||
      ageMs > staleAfterMins * 60_000);
  const activeJob: FeedHealth['activeJob'] = feed.job_id
    ? {
        id: feed.job_id,
        status: feed.job_status || 'queued',
        attempts: Number(feed.job_attempts || 0),
        maxAttempts: Number(feed.job_max_attempts || 0),
        scheduledAt:
          feed.job_scheduled_at == null ? null : Number(feed.job_scheduled_at),
        startedAt:
          feed.job_started_at == null ? null : Number(feed.job_started_at),
      }
    : null;
  const activeFetchLog = Boolean(feed.has_active_fetch);

  let status: FeedHealthStatus;
  if (!feed.enabled) status = 'disabled';
  else if (activeFetchLog || activeJob?.status === 'processing')
    status = 'fetching';
  else if (activeJob?.status === 'queued') status = 'queued';
  else if (
    feed.last_fetch_status === 'error' ||
    Number(feed.error_count || 0) > 0
  )
    status = 'error';
  else if (!feed.last_fetch_at) status = 'never';
  else if (stale) status = 'stale';
  else status = 'healthy';

  return {
    feedId: feed.id,
    status,
    enabled: Boolean(feed.enabled),
    stale,
    ageMs,
    ageMins,
    effectivePollIntervalMins,
    staleAfterMins,
    nextDueAt: Math.min(
      feed.last_fetch_at == null
        ? now
        : feed.last_fetch_at + effectivePollIntervalMins * 60_000,
      activeJob?.status === 'queued' && activeJob.scheduledAt != null
        ? activeJob.scheduledAt
        : Number.POSITIVE_INFINITY,
    ),
    errorCount: Number(feed.error_count || 0),
    recentErrorCount: Number(feed.recent_error_count || 0),
    lastFetchStatus: feed.last_fetch_status || 'never',
    lastFetchAt: feed.last_fetch_at,
    lastSuccessAt: feed.last_success_at ?? null,
    lastError: feed.last_error || '',
    activeJob,
  };
}

export function getFeedHealth(
  feedId: string,
  now = Date.now(),
): FeedHealth | null {
  const db = getDb();
  const row = db
    .prepare(`${GROUPED_FEED_HEALTH_SELECT} WHERE f.id = ?`)
    .get(now - 24 * 60 * 60 * 1000, feedId) as GroupedFeedHealthRow | undefined;
  if (!row) return null;
  return buildFeedHealthFromRow(row, getGlobalPollIntervalMins(), now);
}

export function getAllFeedHealth(now = Date.now()): FeedHealth[] {
  const db = getDb();
  const globalInterval = getGlobalPollIntervalMins();
  const rows = db
    .prepare(`${GROUPED_FEED_HEALTH_SELECT} ORDER BY f.title COLLATE NOCASE`)
    .all(now - 24 * 60 * 60 * 1000) as GroupedFeedHealthRow[];
  return rows.map((row) => buildFeedHealthFromRow(row, globalInterval, now));
}

export function getLatestFeedFetchLog(
  feedId: string,
): FeedFetchLogSummary | null {
  const row = getDb()
    .prepare(
      `
        SELECT id, feed_id, status, articles_found, articles_new,
               error_message, started_at, completed_at, created_at
        FROM feed_fetch_logs
        WHERE feed_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
    )
    .get(feedId) as
    | {
        id: string;
        feed_id: string;
        status: string;
        articles_found: number | null;
        articles_new: number | null;
        error_message: string | null;
        started_at: number | null;
        completed_at: number | null;
        created_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    feedId: row.feed_id,
    status: row.status,
    articlesFound: Number(row.articles_found || 0),
    articlesNew: Number(row.articles_new || 0),
    errorMessage: row.error_message || '',
    startedAt: row.started_at == null ? null : Number(row.started_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    createdAt: Number(row.created_at),
  };
}

export function clearFeedArticles(feedId: string): {
  cleared: number;
  preservedSaved: number;
} {
  const db = getDb();
  return db.transaction(() => {
    const now = Date.now();
    const preserved = db
      .prepare(
        'SELECT COUNT(*) AS count FROM articles WHERE feed_id = ? AND COALESCE(saved, 0) = 1 AND COALESCE(hidden, 0) = 0',
      )
      .get(feedId) as { count: number };
    const result = db
      .prepare(
        `UPDATE articles
         SET hidden = 1, hidden_at = COALESCE(hidden_at, ?),
             read = 1, read_at = COALESCE(read_at, ?),
             cleared_at = ?, updated_at = ?, state_version = state_version + 1
         WHERE feed_id = ? AND COALESCE(hidden, 0) = 0 AND COALESCE(saved, 0) = 0`,
      )
      .run(now, now, now, now, feedId);
    cancelQueuedWorkForClearedArticles(feedId, db);
    db.prepare('UPDATE feeds SET updated_at = ? WHERE id = ?').run(now, feedId);
    return {
      cleared: result.changes,
      preservedSaved: Number(preserved.count || 0),
    };
  })();
}

export function serializeRedditSourceMetadata(
  source: Pick<
    RedditNormalizedSource,
    'redditKind' | 'subreddit' | 'username' | 'query' | 'originalUrl'
  >,
  originalUrl = source.originalUrl,
): string {
  return JSON.stringify({
    originalUrl,
    redditKind: source.redditKind,
    subreddit: source.subreddit,
    username: source.username,
    query: source.query,
  });
}

export function parseRedditSourceMetadata(raw: string | null | undefined): {
  originalUrl?: string;
} {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { originalUrl?: unknown };
    return typeof parsed?.originalUrl === 'string'
      ? { originalUrl: parsed.originalUrl }
      : {};
  } catch {
    return {};
  }
}

export function getFeedExists(feedId: string): { id: string } | undefined {
  return getDb().prepare('SELECT id FROM feeds WHERE id = ?').get(feedId) as
    { id: string } | undefined;
}

export async function parseRefreshForceFlag(
  request: Request,
): Promise<boolean> {
  const body = await readJsonObject(request);
  return body?.force !== false;
}

export function dispatchFeedRefresh(
  feedId: string,
  options: { force: boolean; path?: string },
): {
  success: true;
  queued: boolean;
  job: JobRecord | null;
  fetch: FeedFetchLogSummary | null;
  health: FeedHealth | null;
} {
  if (!options.force) {
    wakePoller();
    return {
      success: true,
      queued: false,
      job: null,
      fetch: getLatestFeedFetchLog(feedId),
      health: getFeedHealth(feedId),
    };
  }

  const now = Date.now();
  const job = enqueueFeedFetch(feedId, { force: true, now });
  if (isClaimableFeedFetchJob(job.id, now)) {
    void runDueJobs({ maxJobs: 1, jobId: job.id })
      .catch((error) => {
        recordAppError({
          source: 'api.feed.refresh.worker',
          error,
          details: { feedId, jobId: job.id },
          path: options.path || `/api/feeds/${feedId}/refresh`,
          method: 'POST',
        });
      })
      .finally(() => scheduleNextPoll());
  } else {
    scheduleNextPoll();
  }

  return {
    success: true,
    queued: job.status === 'queued',
    job,
    fetch: getLatestFeedFetchLog(feedId),
    health: getFeedHealth(feedId),
  };
}

export function dispatchAllFeedsRefresh(options: { force: boolean }): {
  success: true;
  queued: number;
  alreadyActive: number;
  jobs: JobRecord[];
} {
  if (!options.force) {
    wakePoller();
    return {
      success: true,
      queued: 0,
      alreadyActive: 0,
      jobs: [],
    };
  }

  const db = getDb();
  const feeds = db.prepare('SELECT id FROM feeds WHERE enabled = 1').all() as {
    id: string;
  }[];
  const jobs = feeds.map((feed) => enqueueFeedFetch(feed.id, { force: true }));
  void runDueJobs({ maxJobs: Math.max(1, feeds.length) })
    .catch((error) => {
      recordAppError({
        source: 'api.feeds.refresh.worker',
        error,
        details: { feedCount: feeds.length },
        path: '/api/feeds/refresh',
        method: 'POST',
      });
    })
    .finally(() => scheduleNextPoll());

  return {
    success: true,
    queued: jobs.filter((job) => job.status === 'queued').length,
    alreadyActive: jobs.filter((job) => job.status !== 'queued').length,
    jobs,
  };
}

export type DiscoveredFeedSource =
  | {
      ok: true;
      sourceType: 'reddit' | 'rss';
      normalizedUrl: string;
      sourceMetadata: string;
      useProxy: boolean;
      autoEnabledProxy: boolean;
      fetchResult: FetchResult;
      defaultTitle: string;
    }
  | {
      ok: false;
      sourceType: 'reddit' | 'rss';
      error: string;
      useProxy: boolean;
      fetchResult: FetchResult;
    };

export async function discoverAndValidateFeedSource(input: {
  url: string;
  proxyBaseUrl?: string;
  requestedUseProxy?: boolean;
  allowProxyFallback?: boolean;
}): Promise<DiscoveredFeedSource> {
  const {
    url,
    proxyBaseUrl,
    requestedUseProxy = false,
    allowProxyFallback = true,
  } = input;
  const overallDeadline = AbortSignal.timeout(DISCOVERY_OVERALL_TIMEOUT_MS);
  const nextAttemptDeadline = () =>
    AbortSignal.any([
      overallDeadline,
      AbortSignal.timeout(DISCOVERY_ATTEMPT_TIMEOUT_MS),
    ]);

  if (isRedditUrl(url)) {
    const redditSource = normalizeRedditUrl(url);
    let useProxy = Boolean(requestedUseProxy && proxyBaseUrl);
    let autoEnabledProxy = false;
    let validation = await fetchRedditSource(redditSource, {
      proxyBaseUrl: useProxy ? proxyBaseUrl : undefined,
      deadline: nextAttemptDeadline(),
    });
    if (
      !validation.success &&
      !useProxy &&
      allowProxyFallback &&
      proxyBaseUrl &&
      !overallDeadline.aborted
    ) {
      const proxied = await fetchRedditSource(redditSource, {
        proxyBaseUrl,
        deadline: nextAttemptDeadline(),
      });
      if (proxied.success) {
        validation = proxied;
        useProxy = true;
        autoEnabledProxy = true;
      }
    }
    if (!validation.success) {
      return {
        ok: false,
        sourceType: 'reddit',
        error:
          validation.error ||
          'This looks like a Reddit URL, but Reddit did not return a readable JSON feed. Check that the subreddit, user, or search URL exists.',
        useProxy,
        fetchResult: validation,
      };
    }
    return {
      ok: true,
      sourceType: 'reddit',
      normalizedUrl: redditSource.normalizedUrl,
      sourceMetadata: serializeRedditSourceMetadata(redditSource, url),
      useProxy,
      autoEnabledProxy,
      fetchResult: validation,
      defaultTitle:
        validation.title ||
        redditSource.subreddit ||
        redditSource.username ||
        'Reddit',
    };
  }

  let useProxy = Boolean(requestedUseProxy && proxyBaseUrl);
  let autoEnabledProxy = false;
  let result = await fetchFeed(url, {
    discover: true,
    proxyBaseUrl: useProxy ? proxyBaseUrl : undefined,
    deadline: nextAttemptDeadline(),
  });
  if (
    !result.success &&
    !useProxy &&
    allowProxyFallback &&
    proxyBaseUrl &&
    !overallDeadline.aborted
  ) {
    const proxied = await fetchFeed(url, {
      discover: true,
      proxyBaseUrl,
      deadline: nextAttemptDeadline(),
    });
    if (proxied.success) {
      result = proxied;
      useProxy = true;
      autoEnabledProxy = true;
    }
  }
  if (!result.success || !result.subscriptionUrl) {
    return {
      ok: false,
      sourceType: 'rss',
      error: result.error || 'This URL did not return a readable feed',
      useProxy,
      fetchResult: result,
    };
  }
  return {
    ok: true,
    sourceType: 'rss',
    normalizedUrl: normalizeFeedUrl(result.subscriptionUrl),
    sourceMetadata: '{}',
    useProxy,
    autoEnabledProxy,
    fetchResult: result,
    defaultTitle: result.title ?? '',
  };
}
