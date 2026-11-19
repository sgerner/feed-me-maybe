import crypto from 'node:crypto';
import { ProviderHttpError } from '$lib/server/ai/provider-error';
import { SafeFetchError } from '$lib/server/network';
import { getDb } from '$lib/server/db';
import { recordAppError } from '$lib/server/logging';
import { isRankingProviderConfigured } from '$lib/server/ai/jev';

export const FEED_FETCH_JOB_TYPE = 'feed_fetch';
export const AI_PROCESS_JOB_TYPE = 'ai_process';
export const JEV_PROCESS_JOB_TYPE = 'jev_process';

export const DEFAULT_FEED_FETCH_MAX_ATTEMPTS = 4;
const MAX_CONCURRENT_FEED_FETCHES = 3;
export const DEFAULT_AI_PROCESS_MAX_ATTEMPTS = 3;
export const DEFAULT_JEV_PROCESS_MAX_ATTEMPTS = 4;
export const DEFAULT_JEV_QUEUE_CAPACITY = 4;
export const DEFAULT_JEV_BACKFILL_BATCH_SIZE = 4;
export const DEFAULT_JEV_JOBS_PER_RUN = 4;
export const FEED_FETCH_LEASE_MS = 10 * 60 * 1000;
export const AI_PROCESS_LEASE_MS = 30 * 60 * 1000;
export const JEV_PROCESS_LEASE_MS = 5 * 60 * 1000;
export const DEFAULT_RETRY_BASE_MS = 30 * 1000;
export const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const FAILED_JEV_BACKFILL_COOLDOWN_MS = MAX_RETRY_DELAY_MS;

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export type FeedFetchJobPayload = {
  feedId: string;
  force?: boolean;
};

export type AiProcessJobPayload = {
  articleId: string;
  feedId?: string;
};

export type JevProcessJobPayload = {
  articleId: string;
  feedId?: string;
  backfill?: boolean;
  backfillRecovery?: boolean;
  feedback?: boolean;
};

export type JobPayload =
  FeedFetchJobPayload | AiProcessJobPayload | JevProcessJobPayload;

export type JobRecord = {
  id: string;
  type: string;
  status: JobStatus;
  payload: JobPayload | Record<string, unknown>;
  result: Record<string, unknown>;
  errorMessage: string;
  attempts: number;
  maxAttempts: number;
  scheduledAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
};

type RawJobRow = {
  id: string;
  type: string;
  status: string;
  payload: string | null;
  result: string | null;
  error_message: string | null;
  attempts: number;
  max_attempts: number;
  scheduled_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
};

type QueueOptions = {
  now?: number;
  maxAttempts?: number;
  scheduledAt?: number | null;
};

export type RetryDelayOptions = {
  baseMs?: number;
  maxMs?: number;
};

export type RecoveryResult = {
  jobsRequeued: number;
  jobsFailed: number;
  fetchLogsRecovered: number;
};

export type RunJobsOptions = {
  now?: number;
  maxJobs?: number;
};

export type RunJobsResult = {
  processed: number;
  completed: number;
  retried: number;
  failed: number;
  recovered: RecoveryResult;
};

function parseJsonObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toJobRecord(row: RawJobRow): JobRecord {
  const status: JobStatus =
    row.status === 'processing' ||
    row.status === 'completed' ||
    row.status === 'failed'
      ? row.status
      : 'queued';

  return {
    id: row.id,
    type: row.type,
    status,
    payload: parseJsonObject(row.payload),
    result: parseJsonObject(row.result),
    errorMessage: row.error_message || '',
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 0),
    scheduledAt: row.scheduled_at == null ? null : Number(row.scheduled_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    createdAt: Number(row.created_at),
  };
}

function readJob(id: string): JobRecord | null {
  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
    RawJobRow | undefined;
  return row ? toJobRecord(row) : null;
}

function readActiveJob(
  type: string,
  key: string,
  value: string,
): JobRecord | null {
  const payloadPath =
    key === 'articleId' ? '$.articleId' : key === 'feedId' ? '$.feedId' : null;
  if (!payloadPath) throw new Error(`Unsupported active job key: ${key}`);

  const row = getDb()
    .prepare(
      `
        SELECT * FROM jobs
        WHERE type = ?
          AND status IN ('queued', 'processing')
          AND CASE WHEN json_valid(payload) = 1
                   THEN json_extract(payload, '${payloadPath}') END = ?
        ORDER BY CASE status WHEN 'processing' THEN 0 ELSE 1 END, created_at ASC
        LIMIT 1
      `,
    )
    .get(type, value) as RawJobRow | undefined;
  return row ? toJobRecord(row) : null;
}

/**
 * Exponential retry delay for the next attempt. `attempt` is one-based and
 * represents the attempt that just failed.
 */
export function getRetryDelayMs(
  attempt: number,
  options: RetryDelayOptions = {},
): number {
  const baseMs = Math.max(1, options.baseMs ?? DEFAULT_RETRY_BASE_MS);
  const maxMs = Math.max(baseMs, options.maxMs ?? MAX_RETRY_DELAY_MS);
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

function leaseMsForJobType(type: string): number {
  if (type === AI_PROCESS_JOB_TYPE) return AI_PROCESS_LEASE_MS;
  if (type === JEV_PROCESS_JOB_TYPE) return JEV_PROCESS_LEASE_MS;
  return FEED_FETCH_LEASE_MS;
}

function getPayloadId(row: RawJobRow, key: string): string | null {
  const payload = parseJsonObject(row.payload);
  const value = payload[key];
  return typeof value === 'string' && value ? value : null;
}

/**
 * Requeue work left in `processing` after a process restart or a worker crash.
 * The existing `started_at` column acts as a lease timestamp. Jobs that have
 * exhausted their attempt budget become terminally failed instead of looping.
 */
export function recoverAbandonedJobs(now = Date.now()): RecoveryResult {
  const db = getDb();
  const recovered = db
    .transaction(() => {
      const candidates = db
        .prepare(
          `
          SELECT * FROM jobs
          WHERE status = 'processing'
            AND started_at IS NOT NULL
        `,
        )
        .all() as RawJobRow[];

      let jobsRequeued = 0;
      let jobsFailed = 0;
      const feedIds = new Set<string>();

      for (const job of candidates) {
        const startedAt = Number(job.started_at || 0);
        if (now - startedAt < leaseMsForJobType(job.type)) continue;

        const exhausted =
          Number(job.attempts || 0) >= Number(job.max_attempts || 0);
        const message = `Recovered abandoned ${job.type} job after its lease expired`;
        if (job.type === FEED_FETCH_JOB_TYPE) {
          const feedId = getPayloadId(job, 'feedId');
          if (feedId) feedIds.add(feedId);
        }

        if (exhausted) {
          db.prepare(
            `
            UPDATE jobs
            SET status = 'failed', error_message = ?, completed_at = ?, started_at = NULL
            WHERE id = ? AND status = 'processing'
          `,
          ).run(message, now, job.id);
          jobsFailed += 1;
        } else {
          db.prepare(
            `
            UPDATE jobs
            SET status = 'queued', error_message = ?, scheduled_at = ?, started_at = NULL
            WHERE id = ? AND status = 'processing'
          `,
          ).run(message, now, job.id);
          jobsRequeued += 1;
        }
      }

      const staleFetchLogs = db
        .prepare(
          `
          SELECT id, feed_id FROM feed_fetch_logs
          WHERE status = 'fetching'
            AND started_at IS NOT NULL
            AND started_at < ?
        `,
        )
        .all(now - FEED_FETCH_LEASE_MS) as Array<{
        id: string;
        feed_id: string;
      }>;

      for (const log of staleFetchLogs) {
        feedIds.add(log.feed_id);
      }

      if (staleFetchLogs.length > 0) {
        db.prepare(
          `
          UPDATE feed_fetch_logs
          SET status = 'error',
              error_message = 'Fetch abandoned after its lease expired',
              completed_at = ?
          WHERE status = 'fetching'
            AND started_at IS NOT NULL
            AND started_at < ?
        `,
        ).run(now, now - FEED_FETCH_LEASE_MS);
      }

      for (const feedId of feedIds) {
        const activeFetch = db
          .prepare(
            `
            SELECT 1 FROM feed_fetch_logs
            WHERE feed_id = ? AND status = 'fetching'
            LIMIT 1
          `,
          )
          .get(feedId);
        if (activeFetch) continue;

        const latestError = db
          .prepare(
            `
            SELECT error_message FROM feed_fetch_logs
            WHERE feed_id = ? AND status = 'error'
            ORDER BY created_at DESC
            LIMIT 1
          `,
          )
          .get(feedId) as { error_message: string | null } | undefined;
        if (!latestError) continue;

        db.prepare(
          `
          UPDATE feeds
          SET last_fetch_status = 'error',
              last_error = ?,
              error_count = COALESCE(error_count, 0) + 1,
              updated_at = ?
          WHERE id = ?
        `,
        ).run(
          latestError.error_message ||
            'Fetch abandoned after its lease expired',
          now,
          feedId,
        );
      }

      return {
        jobsRequeued,
        jobsFailed,
        fetchLogsRecovered: staleFetchLogs.length,
      };
    })
    .immediate();

  return recovered;
}

function enqueueJob(
  type: string,
  payload: JobPayload,
  key: string,
  value: string,
  options: QueueOptions = {},
): JobRecord {
  const db = getDb();
  const now = options.now ?? Date.now();
  const maxAttempts = options.maxAttempts ?? 3;
  const scheduledAt =
    options.scheduledAt === undefined ? now : options.scheduledAt;

  const enqueueTx = db.transaction(() => {
    const existing = readActiveJob(type, key, value);
    if (existing) {
      const forceRefresh =
        type === FEED_FETCH_JOB_TYPE &&
        (payload as FeedFetchJobPayload).force === true;
      const explicitJevRefresh = type === JEV_PROCESS_JOB_TYPE;
      // Polls should leave retry delays intact. A manual refresh may wake a
      // transient error, but must still honor an upstream Retry-After deadline.
      if (
        scheduledAt !== null &&
        existing.status === 'queued' &&
        (forceRefresh || explicitJevRefresh)
      ) {
        db.prepare(
          `
            UPDATE jobs
            SET scheduled_at = MAX(MIN(COALESCE(scheduled_at, ?), ?), COALESCE(json_extract(result, '$.retryAt'), 0)),
                error_message = '',
                payload = CASE
                  WHEN ? = 1 THEN json_set(payload, '$.force', json('true'))
                  WHEN ? = 1 THEN json_remove(payload, '$.backfill')
                  ELSE payload
                END
            WHERE id = ? AND status = 'queued'
          `,
        ).run(
          scheduledAt,
          scheduledAt,
          forceRefresh ? 1 : 0,
          explicitJevRefresh ? 1 : 0,
          existing.id,
        );
      }
      return readJob(existing.id) || existing;
    }

    const id = crypto.randomUUID();
    db.prepare(
      `
        INSERT INTO jobs (
          id, type, status, payload, result, error_message, attempts,
          max_attempts, scheduled_at, created_at
        ) VALUES (?, ?, 'queued', ?, '{}', '', 0, ?, ?, ?)
      `,
    ).run(id, type, JSON.stringify(payload), maxAttempts, scheduledAt, now);
    return readJob(id) as JobRecord;
  });

  return enqueueTx.immediate();
}

export function enqueueFeedFetch(
  feedId: string,
  options: { force?: boolean; now?: number } = {},
): JobRecord {
  return enqueueJob(
    FEED_FETCH_JOB_TYPE,
    { feedId, force: options.force },
    'feedId',
    feedId,
    {
      now: options.now,
      maxAttempts: DEFAULT_FEED_FETCH_MAX_ATTEMPTS,
    },
  );
}

export function enqueueAiProcess(
  articleId: string,
  options: { feedId?: string; now?: number } = {},
): JobRecord {
  return enqueueJob(
    AI_PROCESS_JOB_TYPE,
    { articleId, feedId: options.feedId },
    'articleId',
    articleId,
    {
      now: options.now,
      maxAttempts: DEFAULT_AI_PROCESS_MAX_ATTEMPTS,
    },
  );
}

export function enqueueJevProcess(
  articleId: string,
  options: { feedId?: string; now?: number; feedback?: boolean } = {},
): JobRecord | null {
  if (!isRankingProviderConfigured()) return null;
  const db = getDb();
  const isActiveArticle = db
    .prepare(
      `SELECT 1 FROM articles
       WHERE id = ?
         AND COALESCE(hidden, 0) = 0
         AND COALESCE(rejected, 0) = 0
         AND COALESCE(thumbs_down, 0) = 0`,
    )
    .get(articleId);
  if (!isActiveArticle) return null;

  if (!options.feedback) {
    const now = options.now ?? Date.now();
    const enqueueTx = db.transaction(() => {
      const existing = readActiveJob(
        JEV_PROCESS_JOB_TYPE,
        'articleId',
        articleId,
      );
      if (existing) return existing;
      const active = db
        .prepare(
          `SELECT COUNT(*) AS count FROM jobs
           WHERE type = ? AND status IN ('queued', 'processing')`,
        )
        .get(JEV_PROCESS_JOB_TYPE) as { count: number };
      if (Number(active.count) >= DEFAULT_JEV_QUEUE_CAPACITY) return null;
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO jobs (
          id, type, status, payload, result, error_message, attempts,
          max_attempts, scheduled_at, created_at
        ) VALUES (?, ?, 'queued', ?, '{}', '', 0, ?, ?, ?)`,
      ).run(
        id,
        JEV_PROCESS_JOB_TYPE,
        JSON.stringify({ articleId, feedId: options.feedId }),
        DEFAULT_JEV_PROCESS_MAX_ATTEMPTS,
        now,
        now,
      );
      return readJob(id) as JobRecord;
    });
    return enqueueTx.immediate();
  }

  const now = options.now ?? Date.now();
  const enqueueTx = db.transaction(() => {
    const activeRows = db
      .prepare(
        `SELECT * FROM jobs
         WHERE type = ? AND status IN ('queued', 'processing')
           AND CASE WHEN json_valid(payload) = 1
                    THEN json_extract(payload, '$.articleId') END = ?
         ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END, created_at ASC`,
      )
      .all(JEV_PROCESS_JOB_TYPE, articleId) as RawJobRow[];
    const queued = activeRows.find((row) => row.status === 'queued');
    if (queued) {
      db.prepare(
        `UPDATE jobs
         SET payload = json_set(payload, '$.feedback', 1, '$.backfill', 0),
             scheduled_at = MIN(COALESCE(scheduled_at, ?), ?)
         WHERE id = ? AND status = 'queued'`,
      ).run(now, now, queued.id);
      return readJob(queued.id) || toJobRecord(queued);
    }

    const active = db
      .prepare(
        `SELECT COUNT(*) AS count FROM jobs
         WHERE type = ? AND status IN ('queued', 'processing')`,
      )
      .get(JEV_PROCESS_JOB_TYPE) as { count: number };
    if (Number(active.count) >= DEFAULT_JEV_QUEUE_CAPACITY) return null;

    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO jobs (
        id, type, status, payload, result, error_message, attempts,
        max_attempts, scheduled_at, created_at
      ) VALUES (?, ?, 'queued', ?, '{}', '', 0, ?, ?, ?)`,
    ).run(
      id,
      JEV_PROCESS_JOB_TYPE,
      JSON.stringify({
        articleId,
        feedId: options.feedId,
        feedback: true,
      } satisfies JevProcessJobPayload),
      DEFAULT_JEV_PROCESS_MAX_ATTEMPTS,
      now,
      now,
    );
    return readJob(id) as JobRecord;
  });

  return enqueueTx.immediate();
}

/**
 * Queue a bounded batch of existing articles without a Jev score. Active jobs
 * and completed backfill jobs are tombstones. Failed jobs get one backfill
 * recovery after a cooldown; a failed recovery is a permanent tombstone.
 */
export function enqueueJevBackfill(
  options: { now?: number; limit?: number } = {},
): number {
  if (!isRankingProviderConfigured()) return 0;

  const requestedLimit = Math.floor(
    options.limit ?? DEFAULT_JEV_BACKFILL_BATCH_SIZE,
  );
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(0, Math.min(DEFAULT_JEV_BACKFILL_BATCH_SIZE, requestedLimit))
    : 0;
  if (limit === 0) return 0;

  const db = getDb();
  const now = options.now ?? Date.now();
  const aiProcessingEnabled = isAiProcessingEnabled();
  const enqueueTx = db.transaction(() => {
    const active = db
      .prepare(
        `SELECT COUNT(*) AS count FROM jobs
         WHERE type = ? AND status IN ('queued', 'processing')`,
      )
      .get(JEV_PROCESS_JOB_TYPE) as { count: number };
    const remainingCapacity = Math.max(
      0,
      DEFAULT_JEV_QUEUE_CAPACITY - Number(active.count),
    );
    const batchSize = Math.min(limit, remainingCapacity);
    if (batchSize === 0) return 0;

    const candidates = db
      .prepare(
        `SELECT a.id, a.feed_id,
                CASE WHEN EXISTS (
                  SELECT 1 FROM jobs j
                  WHERE j.type = 'jev_process'
                    AND CASE WHEN json_valid(j.payload) = 1
                             THEN json_extract(j.payload, '$.articleId') END = +a.id
                    AND j.status = 'failed'
                    AND COALESCE(j.completed_at, j.created_at) <= ?
                ) THEN 1 ELSE 0 END AS backfill_recovery
         FROM articles a
         WHERE a.jev_score IS NULL
           AND COALESCE(a.hidden, 0) = 0
           AND COALESCE(a.rejected, 0) = 0
           AND COALESCE(a.thumbs_down, 0) = 0
           AND NOT EXISTS (
             SELECT 1 FROM ranking_refresh_queue r
             WHERE r.article_id = a.id
           )
           AND (? = 0 OR NOT EXISTS (
             SELECT 1 FROM jobs ai
             WHERE ai.type = 'ai_process'
               AND ai.status IN ('queued', 'processing')
               AND CASE WHEN json_valid(ai.payload) = 1
                        THEN json_extract(ai.payload, '$.articleId') END = +a.id
           ))
           AND NOT EXISTS (
             SELECT 1 FROM jobs j
             WHERE j.type = 'jev_process'
               AND CASE WHEN json_valid(j.payload) = 1
                        THEN json_extract(j.payload, '$.articleId')
                   -- Remove column affinity so SQLite can seek the JSON expression index.
                   END = +a.id
               AND (
                 j.status IN ('queued', 'processing')
                 OR (j.status = 'completed'
                     AND CASE WHEN json_valid(j.payload) = 1
                              THEN json_extract(j.payload, '$.backfill') END = 1)
                 OR (j.status = 'failed'
                     AND (
                       CASE WHEN json_valid(j.payload) = 1
                            THEN json_extract(j.payload, '$.backfillRecovery') END = 1
                       OR COALESCE(j.completed_at, j.created_at) > ?
                     ))
               )
           )
         ORDER BY a.fetched_at DESC, a.id DESC
         LIMIT ?`,
      )
      .all(
        now - FAILED_JEV_BACKFILL_COOLDOWN_MS,
        aiProcessingEnabled ? 1 : 0,
        now - FAILED_JEV_BACKFILL_COOLDOWN_MS,
        batchSize,
      ) as Array<{
      id: string;
      feed_id: string;
      backfill_recovery: number;
    }>;

    const insert = db.prepare(
      `INSERT INTO jobs (
        id, type, status, payload, result, error_message, attempts,
        max_attempts, scheduled_at, created_at
      ) VALUES (?, ?, 'queued', ?, '{}', '', 0, ?, ?, ?)`,
    );
    for (const article of candidates) {
      insert.run(
        crypto.randomUUID(),
        JEV_PROCESS_JOB_TYPE,
        JSON.stringify({
          articleId: article.id,
          feedId: article.feed_id,
          backfill: true,
          ...(article.backfill_recovery ? { backfillRecovery: true } : {}),
        } satisfies JevProcessJobPayload),
        DEFAULT_JEV_PROCESS_MAX_ATTEMPTS,
        now,
        now,
      );
    }
    return candidates.length;
  });

  return enqueueTx.immediate();
}

export function getJob(jobId: string): JobRecord | null {
  return readJob(jobId);
}

export function getLatestFeedFetchJob(feedId: string): JobRecord | null {
  const row = getDb()
    .prepare(
      `
        SELECT * FROM jobs
        WHERE type = ?
          AND CASE WHEN json_valid(payload) = 1
                   THEN json_extract(payload, '$.feedId') END = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
    )
    .get(FEED_FETCH_JOB_TYPE, feedId) as RawJobRow | undefined;
  return row ? toJobRecord(row) : null;
}

function getProviderCooldown(type: string): number {
  const row = getDb()
    .prepare(
      'SELECT CAST(value AS INTEGER) AS due FROM app_settings WHERE key = ?',
    )
    .get(`provider_cooldown_${type}`) as { due: number } | undefined;
  return row?.due ?? 0;
}

function isAiProcessingEnabled(): boolean {
  const row = getDb()
    .prepare("SELECT value FROM app_settings WHERE key = 'ai_enabled'")
    .get() as { value: string } | undefined;
  return row?.value !== 'false';
}

function setProviderCooldown(type: string, retryAt: number, now: number): void {
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = MAX(CAST(app_settings.value AS INTEGER), CAST(excluded.value AS INTEGER)),
       updated_at = excluded.updated_at`,
    )
    .run(`provider_cooldown_${type}`, String(retryAt), now);
}

export function getNextQueuedJobAt(): number | null {
  const rankingProviderConfigured = isRankingProviderConfigured();
  const aiProcessingEnabled = isAiProcessingEnabled();
  const row = getDb()
    .prepare(
      `
        SELECT MIN(scheduled_at) AS scheduled_at FROM (
          SELECT MIN(MAX(COALESCE(scheduled_at, created_at),
            CASE type WHEN 'ai_process' THEN ? WHEN 'jev_process' THEN ? ELSE 0 END
          )) AS scheduled_at
          FROM jobs
          WHERE status = 'queued' AND attempts < max_attempts
            AND (? = 1 OR type != ?)
            AND (? = 1 OR type != ?)
          UNION ALL
          SELECT MIN(MAX(not_before, ?)) AS scheduled_at
          FROM ranking_refresh_queue
          WHERE ? = 1
        )
      `,
    )
    .get(
      getProviderCooldown(AI_PROCESS_JOB_TYPE),
      getProviderCooldown(JEV_PROCESS_JOB_TYPE),
      rankingProviderConfigured ? 1 : 0,
      JEV_PROCESS_JOB_TYPE,
      aiProcessingEnabled ? 1 : 0,
      AI_PROCESS_JOB_TYPE,
      getProviderCooldown(JEV_PROCESS_JOB_TYPE),
      rankingProviderConfigured ? 1 : 0,
    ) as { scheduled_at: number | null } | undefined;
  return row?.scheduled_at == null ? null : Number(row.scheduled_at);
}

function claimNextJob(
  now: number,
  options: {
    allowJev?: boolean;
    allowFeed?: boolean;
    allowScoring?: boolean;
  } = {},
): JobRecord | null {
  const db = getDb();
  const claimTx = db.transaction(() => {
    const row = db
      .prepare(
        `
          SELECT * FROM jobs
          WHERE status = 'queued'
            AND (scheduled_at IS NULL OR scheduled_at <= ?)
            AND attempts < max_attempts
            AND (? = 1 OR type != ?)
            AND (? = 1 OR type != ?)
            AND (? = 1 OR type != ?)
            AND (? = 1 OR type = ?)
            AND (type != ? OR NOT EXISTS (
              SELECT 1 FROM ranking_refresh_queue q
              WHERE q.article_id = CASE WHEN json_valid(jobs.payload) = 1
                THEN json_extract(jobs.payload, '$.articleId') END
                AND q.not_before > ?
            ))
          ORDER BY CASE
                     WHEN type = ? THEN 0
                     WHEN type = ? AND json_valid(payload) = 1
                       AND json_extract(payload, '$.feedback') = 1 THEN 1
                     WHEN type = ? THEN 2
                     ELSE 1
                   END ASC,
                   COALESCE(scheduled_at, created_at) ASC, created_at ASC
          LIMIT 1
        `,
      )
      .get(
        now,
        options.allowJev === false ||
          getProviderCooldown(JEV_PROCESS_JOB_TYPE) > now
          ? 0
          : 1,
        JEV_PROCESS_JOB_TYPE,
        options.allowFeed === false ? 0 : 1,
        FEED_FETCH_JOB_TYPE,
        getProviderCooldown(AI_PROCESS_JOB_TYPE) > now ||
          !isAiProcessingEnabled()
          ? 0
          : 1,
        AI_PROCESS_JOB_TYPE,
        options.allowScoring === false ? 0 : 1,
        FEED_FETCH_JOB_TYPE,
        JEV_PROCESS_JOB_TYPE,
        now,
        FEED_FETCH_JOB_TYPE,
        JEV_PROCESS_JOB_TYPE,
        JEV_PROCESS_JOB_TYPE,
      ) as RawJobRow | undefined;
    if (!row) return null;

    const result = db
      .prepare(
        `
          UPDATE jobs
          SET status = 'processing', attempts = attempts + 1,
              started_at = ?, error_message = ''
          WHERE id = ? AND status = 'queued' AND attempts < max_attempts
        `,
      )
      .run(now, row.id);
    if (result.changes !== 1) return null;
    return readJob(row.id);
  });

  return claimTx.immediate();
}

function completeJob(
  job: JobRecord,
  result: Record<string, unknown>,
  now: number,
): void {
  getDb()
    .prepare(
      `
        UPDATE jobs
        SET status = 'completed', result = ?, error_message = '',
            completed_at = ?, started_at = NULL, scheduled_at = NULL
        WHERE id = ? AND status = 'processing'
      `,
    )
    .run(JSON.stringify(result), now, job.id);
}

class FeedJobError extends Error {
  constructor(
    message: string,
    readonly permanent = false,
    readonly retryAt?: number,
  ) {
    super(message);
  }
}

function failOrRetryJob(
  job: JobRecord,
  error: unknown,
  now: number,
): 'retried' | 'failed' {
  const db = getDb();
  const message =
    error instanceof Error
      ? error.message
      : String(error || 'Unknown job error');
  const cause = error instanceof Error ? error.cause : undefined;
  const providerRejection = error instanceof ProviderHttpError ? error : cause;
  if (
    (job.type === AI_PROCESS_JOB_TYPE || job.type === JEV_PROCESS_JOB_TYPE) &&
    providerRejection instanceof ProviderHttpError &&
    [401, 403, 429].includes(providerRejection.status)
  ) {
    setProviderCooldown(
      job.type,
      Math.max(now + 60_000, providerRejection.retryAt ?? 0),
      now,
    );
  }
  const networkError = error instanceof SafeFetchError ? error : cause;
  const exhausted =
    job.attempts >= job.maxAttempts ||
    (error instanceof FeedJobError && error.permanent) ||
    (providerRejection instanceof ProviderHttpError &&
      providerRejection.permanent) ||
    (networkError instanceof SafeFetchError &&
      networkError.code !== 'dns_failure');
  if (exhausted) {
    db.prepare(
      `
        UPDATE jobs
        SET status = 'failed', error_message = ?, completed_at = ?, started_at = NULL
        WHERE id = ? AND status = 'processing'
      `,
    ).run(message, now, job.id);
    return 'failed';
  }

  const retryAt =
    providerRejection instanceof ProviderHttpError
      ? providerRejection.retryAt
      : undefined;
  const feedRetryAt = error instanceof FeedJobError ? error.retryAt : undefined;
  const scheduledAt = Math.max(
    now + getRetryDelayMs(job.attempts),
    retryAt ?? 0,
    feedRetryAt ?? 0,
  );
  db.prepare(
    `
      UPDATE jobs
      SET status = 'queued', error_message = ?, scheduled_at = ?, started_at = NULL, result = ?
      WHERE id = ? AND status = 'processing'
    `,
  ).run(message, scheduledAt, JSON.stringify({ retryAt: feedRetryAt }), job.id);
  return 'retried';
}

async function executeJob(job: JobRecord): Promise<Record<string, unknown>> {
  const payload = job.payload as Record<string, unknown>;

  if (job.type === FEED_FETCH_JOB_TYPE) {
    const feedId = typeof payload.feedId === 'string' ? payload.feedId : '';
    if (!feedId)
      throw new FeedJobError('Feed fetch job is missing feedId', true);
    const { ingestFeed } = await import('$lib/server/feed/ingester');
    const result = await ingestFeed({
      feedId,
      force: payload.force === true || payload.force === 1,
      countFailure: job.attempts === 1,
    });
    if (!result.success && !result.skipped) {
      throw new FeedJobError(
        result.error || 'Feed ingestion failed',
        result.permanentFailure,
        result.retryAt,
      );
    }
    return result as unknown as Record<string, unknown>;
  }

  if (job.type === AI_PROCESS_JOB_TYPE) {
    const articleId =
      typeof payload.articleId === 'string' ? payload.articleId : '';
    if (!articleId) throw new Error('AI process job is missing articleId');
    const { processArticle } = await import('$lib/server/ai/processor');
    await processArticle(articleId);
    return { articleId, processed: true };
  }

  if (job.type === JEV_PROCESS_JOB_TYPE) {
    const articleId =
      typeof payload.articleId === 'string' ? payload.articleId : '';
    if (!articleId) throw new Error('Jev process job is missing articleId');
    const article = getDb()
      .prepare('SELECT jev_score FROM articles WHERE id = ?')
      .get(articleId) as { jev_score: number | null } | undefined;
    if (
      !article ||
      ((payload.backfill === true || payload.feedback === true) &&
        article.jev_score != null)
    ) {
      return { articleId, processed: false, skipped: true };
    }
    // The claim query excludes Jev jobs when configuration is absent. Keep a
    // second check here in case configuration changes after the claim.
    if (!isRankingProviderConfigured()) {
      throw new Error('Selected ranking provider is not configured');
    }
    const { processJevArticle } = await import('$lib/server/ai/jev');
    await processJevArticle(articleId);
    return { articleId, processed: true };
  }

  throw new Error(`Unsupported job type: ${job.type}`);
}

let activeRun: Promise<RunJobsResult> | null = null;
type JobRunControl = { budget: number; processed: number; wake?: () => void };
let runControl: JobRunControl | null = null;

async function runDueJobsInternal(
  options: RunJobsOptions,
  control: JobRunControl,
): Promise<RunJobsResult> {
  const now = options.now ?? Date.now();
  const recovered = recoverAbandonedJobs(now);
  const { flushRankingRefreshQueue } =
    await import('$lib/server/ranking-freshness');
  // Preference refreshes use their own durable lane and claim Jev capacity
  // before ordinary unscored-article backfill.
  await flushRankingRefreshQueue(now, DEFAULT_JEV_QUEUE_CAPACITY);
  enqueueJevBackfill({ now });
  const result: RunJobsResult = {
    processed: 0,
    completed: 0,
    retried: 0,
    failed: 0,
    recovered,
  };
  let jevExecutions = 0;

  async function processJob(job: JobRecord) {
    try {
      const output = await executeJob(job);
      completeJob(job, output, Date.now());
      result.completed += 1;
    } catch (error) {
      const disposition = failOrRetryJob(job, error, Date.now());
      result[disposition] += 1;
      recordAppError({
        source: 'jobs.worker',
        error,
        details: {
          jobId: job.id,
          jobType: job.type,
          attempts: job.attempts,
          disposition,
        },
      });
    }
  }

  const pending = new Set<Promise<void>>();
  let activeFeeds = 0;
  let scoring = false;
  let workerFailure: { error: unknown } | undefined;
  try {
    while (!workerFailure) {
      let job: JobRecord | null = null;
      if (result.processed < control.budget) {
        await flushRankingRefreshQueue(Date.now(), DEFAULT_JEV_QUEUE_CAPACITY);
        job = claimNextJob(Date.now(), {
          allowFeed: activeFeeds < MAX_CONCURRENT_FEED_FETCHES,
          allowScoring: !scoring,
          allowJev:
            isRankingProviderConfigured() &&
            jevExecutions < DEFAULT_JEV_JOBS_PER_RUN,
        });
      }
      if (!job) {
        if (!pending.size) break;
        const wake = new Promise<void>((resolve) => {
          control.wake = resolve;
        });
        await Promise.race([wake, ...pending]);
        control.wake = undefined;
        continue;
      }
      result.processed += 1;
      control.processed = result.processed;
      if (job.type === JEV_PROCESS_JOB_TYPE) jevExecutions += 1;
      const isFeed = job.type === FEED_FETCH_JOB_TYPE;
      if (isFeed) activeFeeds += 1;
      else scoring = true;
      const work = processJob(job)
        .catch((error: unknown) => {
          workerFailure ??= { error };
        })
        .finally(() => {
          if (isFeed) activeFeeds -= 1;
          else scoring = false;
          pending.delete(work);
        });
      pending.add(work);
    }
  } finally {
    await Promise.all(pending);
  }
  if (workerFailure) throw workerFailure.error;

  return result;
}

/**
 * Runs a bounded set of feed requests alongside one scoring job. The process-local promise prevents duplicate
 * workers from competing when several requests or poller ticks arrive at
 * once; the SQLite claim transaction protects separate processes/instances.
 */
export function runDueJobs(
  options: RunJobsOptions = {},
): Promise<RunJobsResult> {
  const budget = Math.max(1, Math.floor(options.maxJobs ?? 16));
  if (activeRun && runControl) {
    runControl.budget = Math.max(
      runControl.budget,
      runControl.processed + budget,
    );
    runControl.wake?.();
    return activeRun;
  }
  runControl = { budget, processed: 0 };
  activeRun = runDueJobsInternal(options, runControl).finally(() => {
    activeRun = null;
    runControl = null;
  });
  return activeRun;
}
