import { getDb } from '$lib/server/db';

const MIN_POLL_INTERVAL_MINS = 1;
const MAX_POLL_INTERVAL_MINS = 24 * 60;

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
  if (!value) return '';
  try {
    const url = new URL(value.trim());
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (url.protocol === 'http:' && url.port === '80') url.port = '';
    if (url.protocol === 'https:' && url.port === '443') url.port = '';
    if (url.pathname.length > 1)
      url.pathname = url.pathname.replace(/\/+$/, '');

    const sortedParams = [...url.searchParams.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    url.search = '';
    for (const [key, val] of sortedParams) url.searchParams.append(key, val);
    return url.href;
  } catch {
    return value.trim();
  }
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
): number {
  let interval = parsePollInterval(feedInterval, globalInterval);
  const quietFetches = Math.max(0, Number(fetchCountSinceChange || 0));
  if (quietFetches > 10) interval *= 2;
  if (quietFetches > 50) interval *= 2;
  return Math.min(MAX_POLL_INTERVAL_MINS, interval);
}

function getActiveFeedJob(feedId: string): FeedHealth['activeJob'] {
  const row = getDb()
    .prepare(
      `
        SELECT id, status, attempts, max_attempts, scheduled_at, started_at
        FROM jobs
        WHERE type = 'feed_fetch'
          AND status IN ('queued', 'processing')
          AND json_valid(payload) = 1
          AND json_extract(payload, '$.feedId') = ?
        ORDER BY CASE status WHEN 'processing' THEN 0 ELSE 1 END, created_at ASC
        LIMIT 1
      `,
    )
    .get(feedId) as
    | {
        id: string;
        status: string;
        attempts: number;
        max_attempts: number;
        scheduled_at: number | null;
        started_at: number | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 0),
    scheduledAt: row.scheduled_at == null ? null : Number(row.scheduled_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
  };
}

export function getFeedHealth(
  feedId: string,
  now = Date.now(),
): FeedHealth | null {
  const db = getDb();
  const feed = db
    .prepare(
      `
        SELECT id, enabled, poll_interval_mins, fetch_count_since_change,
               error_count, last_fetch_status, last_fetch_at, last_error
        FROM feeds WHERE id = ?
      `,
    )
    .get(feedId) as FeedHealthRow | undefined;
  if (!feed) return null;

  const globalInterval = getGlobalPollIntervalMins();
  const effectivePollIntervalMins = getEffectivePollIntervalMins(
    feed.poll_interval_mins,
    feed.fetch_count_since_change,
    globalInterval,
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
  const activeJob = getActiveFeedJob(feedId);
  const activeFetchLog = db
    .prepare(
      "SELECT 1 FROM feed_fetch_logs WHERE feed_id = ? AND status IN ('pending', 'fetching') LIMIT 1",
    )
    .get(feedId);
  const lastSuccess = db
    .prepare(
      "SELECT MAX(completed_at) as completed_at FROM feed_fetch_logs WHERE feed_id = ? AND status = 'success'",
    )
    .get(feedId) as { completed_at: number | null } | undefined;
  const recentError = db
    .prepare(
      "SELECT COUNT(*) as count FROM feed_fetch_logs WHERE feed_id = ? AND status = 'error' AND created_at >= ?",
    )
    .get(feedId, now - 24 * 60 * 60 * 1000) as { count: number };

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
    feedId,
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
    recentErrorCount: Number(recentError?.count || 0),
    lastFetchStatus: feed.last_fetch_status || 'never',
    lastFetchAt: feed.last_fetch_at,
    lastSuccessAt: lastSuccess?.completed_at ?? null,
    lastError: feed.last_error || '',
    activeJob,
  };
}

export function getAllFeedHealth(now = Date.now()): FeedHealth[] {
  const feeds = getDb()
    .prepare('SELECT id FROM feeds ORDER BY title COLLATE NOCASE')
    .all() as Array<{
    id: string;
  }>;
  return feeds
    .map((feed) => getFeedHealth(feed.id, now))
    .filter((health): health is FeedHealth => Boolean(health));
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

export function clearFeedArticles(feedId: string): number {
  const db = getDb();
  return db.transaction(() => {
    const result = db
      .prepare(
        'UPDATE articles SET hidden = 1 WHERE feed_id = ? AND hidden = 0',
      )
      .run(feedId);
    db.prepare('UPDATE feeds SET updated_at = ? WHERE id = ?').run(
      Date.now(),
      feedId,
    );
    return result.changes;
  })();
}
