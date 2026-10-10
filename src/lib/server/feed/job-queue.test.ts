import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const jevMocks = vi.hoisted(() => ({
  isJevConfigured: vi.fn(() => true),
  processJevArticle: vi.fn(async () => undefined),
}));
const aiMocks = vi.hoisted(() => ({
  processArticle: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/ai/jev', () => jevMocks);
vi.mock('$lib/server/ai/processor', () => aiMocks);

describe('feed job queue', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-feed-job-queue.db');
  const originalDbUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbPath;
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const { initializeDatabase } = await import('$lib/server/db/migrate');
    initializeDatabase();
  });

  beforeEach(async () => {
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    db.prepare('DELETE FROM feed_fetch_logs').run();
    db.prepare('DELETE FROM jobs').run();
    db.prepare('DELETE FROM feeds').run();
    db.prepare('DELETE FROM app_error_logs').run();
    jevMocks.isJevConfigured.mockReturnValue(true);
    jevMocks.processJevArticle.mockReset().mockResolvedValue(undefined);
    aiMocks.processArticle.mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    const { closeDb } = await import('$lib/server/db');
    closeDb();
    process.env.DATABASE_URL = originalDbUrl ?? '';
    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${testDbPath}${suffix}`;
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it('calculates capped exponential retry delays', async () => {
    const { getRetryDelayMs } = await import('./job-queue');
    expect(getRetryDelayMs(1, { baseMs: 1_000, maxMs: 5_000 })).toBe(1_000);
    expect(getRetryDelayMs(2, { baseMs: 1_000, maxMs: 5_000 })).toBe(2_000);
    expect(getRetryDelayMs(3, { baseMs: 1_000, maxMs: 5_000 })).toBe(4_000);
    expect(getRetryDelayMs(4, { baseMs: 1_000, maxMs: 5_000 })).toBe(5_000);
  });

  it('deduplicates active feed jobs and wakes queued retries', async () => {
    const { enqueueFeedFetch } = await import('./job-queue');
    const first = enqueueFeedFetch('feed-1', { now: 10_000 });
    const second = enqueueFeedFetch('feed-1', { now: 20_000 });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe('queued');

    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    db.prepare(
      'UPDATE jobs SET scheduled_at = ?, error_message = ? WHERE id = ?',
    ).run(90_000, 'temporary error', first.id);
    const woken = enqueueFeedFetch('feed-1', { force: true, now: 30_000 });
    const row = db
      .prepare(
        'SELECT scheduled_at, error_message, payload FROM jobs WHERE id = ?',
      )
      .get(first.id) as {
      scheduled_at: number;
      error_message: string;
      payload: string;
    };

    expect(woken.id).toBe(first.id);
    expect(row.scheduled_at).toBe(30_000);
    expect(row.error_message).toBe('');
    expect(JSON.parse(row.payload).force).toBe(1);
  });

  it('recovers abandoned processing jobs and fetch logs', async () => {
    const { FEED_FETCH_LEASE_MS, recoverAbandonedJobs } =
      await import('./job-queue');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = 10_000_000;
    const startedAt = now - FEED_FETCH_LEASE_MS - 1;

    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-recover', 'https://example.com/feed', now, now);
    db.prepare(
      'INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'job-recover',
      'feed_fetch',
      'processing',
      JSON.stringify({ feedId: 'feed-recover' }),
      1,
      4,
      startedAt,
      startedAt,
    );
    db.prepare(
      'INSERT INTO feed_fetch_logs (id, feed_id, status, started_at, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('log-recover', 'feed-recover', 'fetching', startedAt, startedAt);

    const result = recoverAbandonedJobs(now);
    const job = db
      .prepare(
        'SELECT status, scheduled_at, started_at, error_message FROM jobs WHERE id = ?',
      )
      .get('job-recover') as {
      status: string;
      scheduled_at: number;
      started_at: number | null;
      error_message: string;
    };
    const log = db
      .prepare(
        'SELECT status, completed_at, error_message FROM feed_fetch_logs WHERE id = ?',
      )
      .get('log-recover') as {
      status: string;
      completed_at: number;
      error_message: string;
    };
    const feed = db
      .prepare(
        'SELECT error_count, last_fetch_status, last_error FROM feeds WHERE id = ?',
      )
      .get('feed-recover') as {
      error_count: number;
      last_fetch_status: string;
      last_error: string;
    };

    expect(result.jobsRequeued).toBe(1);
    expect(result.jobsFailed).toBe(0);
    expect(result.fetchLogsRecovered).toBe(1);
    expect(job.status).toBe('queued');
    expect(job.scheduled_at).toBe(now);
    expect(job.started_at).toBeNull();
    expect(job.error_message).toContain('lease expired');
    expect(log.status).toBe('error');
    expect(log.completed_at).toBe(now);
    expect(log.error_message).toContain('lease expired');
    expect(feed.error_count).toBe(1);
    expect(feed.last_fetch_status).toBe('error');
  });

  it('retries failed jobs and eventually marks them failed', async () => {
    const { runDueJobs } = await import('./job-queue');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, scheduled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'job-unsupported',
      'unsupported',
      'queued',
      '{}',
      0,
      2,
      now - 1,
      now - 1,
    );

    const first = await runDueJobs({ now, maxJobs: 1 });
    const retried = db
      .prepare(
        'SELECT status, attempts, scheduled_at, error_message FROM jobs WHERE id = ?',
      )
      .get('job-unsupported') as {
      status: string;
      attempts: number;
      scheduled_at: number;
      error_message: string;
    };
    expect(first.retried).toBe(1);
    expect(retried.status).toBe('queued');
    expect(retried.attempts).toBe(1);
    expect(retried.scheduled_at).toBeGreaterThan(now);
    expect(retried.error_message).toContain('Unsupported job type');

    db.prepare('UPDATE jobs SET scheduled_at = ? WHERE id = ?').run(
      Date.now() - 1,
      'job-unsupported',
    );
    const second = await runDueJobs({ maxJobs: 1 });
    const failed = db
      .prepare('SELECT status, attempts, completed_at FROM jobs WHERE id = ?')
      .get('job-unsupported') as {
      status: string;
      attempts: number;
      completed_at: number | null;
    };
    expect(second.failed).toBe(1);
    expect(failed.status).toBe('failed');
    expect(failed.attempts).toBe(2);
    expect(failed.completed_at).not.toBeNull();
  });

  it('backfills missing scores except failed, active, or completed backfill jobs', async () => {
    const { enqueueJevBackfill, JEV_PROCESS_JOB_TYPE } =
      await import('./job-queue');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = 50_000;

    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-jev-backfill', 'https://example.com/jev', now, now);

    const article = db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, jev_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    article.run(
      'jev-new-1',
      'feed-jev-backfill',
      'https://example.com/1',
      'One',
      null,
      now,
      now,
      now,
    );
    article.run(
      'jev-terminal',
      'feed-jev-backfill',
      'https://example.com/2',
      'Two',
      null,
      now + 1,
      now + 1,
      now + 1,
    );
    article.run(
      'jev-completed',
      'feed-jev-backfill',
      'https://example.com/3',
      'Three',
      null,
      now + 2,
      now + 2,
      now + 2,
    );
    article.run(
      'jev-scored',
      'feed-jev-backfill',
      'https://example.com/4',
      'Four',
      72,
      now + 3,
      now + 3,
      now + 3,
    );
    article.run(
      'jev-new-2',
      'feed-jev-backfill',
      'https://example.com/5',
      'Five',
      null,
      now + 4,
      now + 4,
      now + 4,
    );
    article.run(
      'jev-completed-backfill',
      'feed-jev-backfill',
      'https://example.com/6',
      'Six',
      null,
      now + 5,
      now + 5,
      now + 5,
    );
    article.run(
      'jev-active',
      'feed-jev-backfill',
      'https://example.com/7',
      'Seven',
      null,
      now + 6,
      now + 6,
      now + 6,
    );

    const insertPriorJob = db.prepare(
      'INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, created_at) VALUES (?, ?, ?, ?, 1, 4, ?)',
    );
    insertPriorJob.run(
      'job-jev-terminal',
      JEV_PROCESS_JOB_TYPE,
      'failed',
      JSON.stringify({ articleId: 'jev-terminal' }),
      now,
    );
    insertPriorJob.run(
      'job-jev-completed',
      JEV_PROCESS_JOB_TYPE,
      'completed',
      JSON.stringify({ articleId: 'jev-completed' }),
      now,
    );
    insertPriorJob.run(
      'job-jev-completed-backfill',
      JEV_PROCESS_JOB_TYPE,
      'completed',
      JSON.stringify({ articleId: 'jev-completed-backfill', backfill: true }),
      now,
    );
    insertPriorJob.run(
      'job-jev-active',
      JEV_PROCESS_JOB_TYPE,
      'processing',
      JSON.stringify({ articleId: 'jev-active' }),
      now,
    );

    const queued = enqueueJevBackfill({ now, limit: 10 });
    const jobs = db
      .prepare(
        "SELECT json_extract(payload, '$.articleId') AS article_id FROM jobs WHERE type = ? AND status = 'queued' ORDER BY created_at, id",
      )
      .all(JEV_PROCESS_JOB_TYPE) as Array<{ article_id: string }>;

    expect(queued).toBe(3);
    expect(jobs.map(({ article_id }) => article_id).sort()).toEqual([
      'jev-completed',
      'jev-new-1',
      'jev-new-2',
    ]);
  });

  it('bounds Jev backfill to four active jobs and deduplicates repeated runs', async () => {
    const { enqueueJevBackfill, JEV_PROCESS_JOB_TYPE } =
      await import('./job-queue');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = 70_000;

    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-jev-bound', 'https://example.com/bound', now, now);
    const article = db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (let index = 1; index <= 6; index += 1) {
      article.run(
        `jev-bound-${index}`,
        'feed-jev-bound',
        `https://example.com/bound/${index}`,
        `Article ${index}`,
        now + index,
        now + index,
        now + index,
      );
    }

    expect(enqueueJevBackfill({ now })).toBe(4);
    expect(enqueueJevBackfill({ now: now + 1 })).toBe(0);

    const jobs = db
      .prepare('SELECT COUNT(*) AS count FROM jobs WHERE type = ?')
      .get(JEV_PROCESS_JOB_TYPE) as { count: number };
    expect(jobs.count).toBe(4);
  });

  it('recovers expired Jev leases and fails jobs that exhausted their attempts', async () => {
    const { JEV_PROCESS_LEASE_MS, recoverAbandonedJobs } =
      await import('./job-queue');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = 20_000_000;
    const startedAt = now - JEV_PROCESS_LEASE_MS - 1;
    const insert = db.prepare(
      'INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run(
      'jev-recoverable',
      'jev_process',
      'processing',
      JSON.stringify({ articleId: 'article-recoverable' }),
      1,
      4,
      startedAt,
      startedAt,
    );
    insert.run(
      'jev-exhausted',
      'jev_process',
      'processing',
      JSON.stringify({ articleId: 'article-exhausted' }),
      4,
      4,
      startedAt,
      startedAt,
    );

    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-jev-recovery', 'https://example.com/recovery', now, now);
    db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'article-exhausted',
      'feed-jev-recovery',
      'https://example.com/recovery/exhausted',
      'Exhausted article',
      now,
      now,
      now,
    );

    const recovered = recoverAbandonedJobs(now);
    const jobs = db
      .prepare(
        'SELECT id, status, scheduled_at, started_at, completed_at FROM jobs WHERE id IN (?, ?) ORDER BY id',
      )
      .all('jev-exhausted', 'jev-recoverable') as Array<{
      id: string;
      status: string;
      scheduled_at: number | null;
      started_at: number | null;
      completed_at: number | null;
    }>;

    expect(recovered.jobsRequeued).toBe(1);
    expect(recovered.jobsFailed).toBe(1);
    expect(jobs).toEqual([
      {
        id: 'jev-exhausted',
        status: 'failed',
        scheduled_at: null,
        started_at: null,
        completed_at: now,
      },
      {
        id: 'jev-recoverable',
        status: 'queued',
        scheduled_at: now,
        started_at: null,
        completed_at: null,
      },
    ]);

    const { enqueueJevBackfill } = await import('./job-queue');
    expect(enqueueJevBackfill({ now: now + 1 })).toBe(0);
    const jevJobs = db
      .prepare("SELECT COUNT(*) AS count FROM jobs WHERE type = 'jev_process'")
      .get() as { count: number };
    expect(jevJobs.count).toBe(2);
  });

  it('retries Jev failures and stops after the configured attempt limit', async () => {
    const { runDueJobs } = await import('./job-queue');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-jev-retry', 'https://example.com/retry', now, now);
    db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'article-retry',
      'feed-jev-retry',
      'https://example.com/retry/article',
      'Retry article',
      now,
      now,
      now,
    );
    jevMocks.processJevArticle.mockRejectedValue(new Error('Jev unavailable'));
    db.prepare(
      'INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, scheduled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'jev-retry',
      'jev_process',
      'queued',
      JSON.stringify({ articleId: 'article-retry' }),
      0,
      2,
      now - 1,
      now - 1,
    );

    const first = await runDueJobs({ now, maxJobs: 1 });
    let job = db
      .prepare('SELECT status, attempts, error_message FROM jobs WHERE id = ?')
      .get('jev-retry') as {
      status: string;
      attempts: number;
      error_message: string;
    };
    expect(first.retried).toBe(1);
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(1);
    expect(job.error_message).toBe('Jev unavailable');

    db.prepare('UPDATE jobs SET scheduled_at = ? WHERE id = ?').run(
      Date.now() - 1,
      'jev-retry',
    );
    const second = await runDueJobs({ maxJobs: 1 });
    job = db
      .prepare('SELECT status, attempts, error_message FROM jobs WHERE id = ?')
      .get('jev-retry') as {
      status: string;
      attempts: number;
      error_message: string;
    };
    expect(second.failed).toBe(1);
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(2);
    expect(job.error_message).toBe('Jev unavailable');
  });

  it('keeps a Jev retry schedule and allows an explicit refresh for scored articles', async () => {
    const { enqueueJevBackfill, enqueueJevProcess, runDueJobs } =
      await import('./job-queue');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-jev-refresh', 'https://example.com/refresh', now, now);
    const insertArticle = db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, jev_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertArticle.run(
      'article-pending-retry',
      'feed-jev-refresh',
      'https://example.com/refresh/retry',
      'Pending retry',
      null,
      now,
      now,
      now,
    );
    insertArticle.run(
      'article-scored-refresh',
      'feed-jev-refresh',
      'https://example.com/refresh/scored',
      'Scored refresh',
      83,
      now + 1,
      now + 1,
      now + 1,
    );

    const retryAt = now + 60_000;
    db.prepare(
      'INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, scheduled_at, created_at, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'jev-future-retry',
      'jev_process',
      'queued',
      JSON.stringify({ articleId: 'article-pending-retry' }),
      1,
      4,
      retryAt,
      now,
      'temporary Jev failure',
    );

    expect(enqueueJevBackfill({ now: now + 1 })).toBe(0);
    const retry = db
      .prepare('SELECT scheduled_at, error_message FROM jobs WHERE id = ?')
      .get('jev-future-retry') as {
      scheduled_at: number;
      error_message: string;
    };
    expect(retry.scheduled_at).toBe(retryAt);
    expect(retry.error_message).toBe('temporary Jev failure');

    const refresh = enqueueJevProcess('article-scored-refresh', {
      now: now - 1,
    });
    expect(refresh).not.toBeNull();
    const result = await runDueJobs({ now, maxJobs: 1 });
    expect(result.completed).toBe(1);
    expect(jevMocks.processJevArticle).toHaveBeenCalledWith(
      'article-scored-refresh',
    );
  });

  it('leaves Jev jobs queued while Jev is unconfigured and hides them from scheduling', async () => {
    const { enqueueJevBackfill, getNextQueuedJobAt, runDueJobs } =
      await import('./job-queue');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = Date.now();
    jevMocks.isJevConfigured.mockReturnValue(false);
    db.prepare(
      'INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, scheduled_at, created_at) VALUES (?, ?, ?, ?, 0, 4, ?, ?)',
    ).run(
      'jev-unconfigured',
      'jev_process',
      'queued',
      JSON.stringify({ articleId: 'article-unconfigured' }),
      now - 1,
      now - 1,
    );

    expect(enqueueJevBackfill({ now })).toBe(0);
    expect(getNextQueuedJobAt()).toBeNull();
    const result = await runDueJobs({ now, maxJobs: 1 });
    const job = db
      .prepare('SELECT status, attempts FROM jobs WHERE id = ?')
      .get('jev-unconfigured') as { status: string; attempts: number };

    expect(result.processed).toBe(0);
    expect(job).toEqual({ status: 'queued', attempts: 0 });
    expect(jevMocks.processJevArticle).not.toHaveBeenCalled();
  });

  it('prioritizes non-Jev work and caps Jev executions per worker run', async () => {
    const { AI_PROCESS_JOB_TYPE, JEV_PROCESS_JOB_TYPE, runDueJobs } =
      await import('./job-queue');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-jev-fair', 'https://example.com/fair', now, now);
    const insertArticle = db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insert = db.prepare(
      'INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, scheduled_at, created_at) VALUES (?, ?, ?, ?, 0, 4, ?, ?)',
    );
    for (let index = 1; index <= 8; index += 1) {
      insertArticle.run(
        `jev-fair-article-${index}`,
        'feed-jev-fair',
        `https://example.com/fair/${index}`,
        `Jev article ${index}`,
        now + index,
        now + index,
        now + index,
      );
      insert.run(
        `jev-fair-${index}`,
        JEV_PROCESS_JOB_TYPE,
        'queued',
        JSON.stringify({ articleId: `jev-fair-article-${index}` }),
        now - 10,
        now - 100 + index,
      );
    }
    insertArticle.run(
      'ai-fair-article',
      'feed-jev-fair',
      'https://example.com/fair/ai',
      'AI article',
      now + 9,
      now + 9,
      now + 9,
    );
    insert.run(
      'ai-fair-1',
      AI_PROCESS_JOB_TYPE,
      'queued',
      JSON.stringify({ articleId: 'ai-fair-article' }),
      now - 10,
      now,
    );

    const result = await runDueJobs({ now, maxJobs: 5 });
    const jevCompleted = db
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE type = ? AND status = 'completed'",
      )
      .get(JEV_PROCESS_JOB_TYPE) as { count: number };
    const ai = db
      .prepare('SELECT status FROM jobs WHERE id = ?')
      .get('ai-fair-1') as { status: string };

    expect(result.completed).toBe(5);
    expect(ai.status).toBe('completed');
    expect(jevCompleted.count).toBeLessThanOrEqual(4);
    expect(jevCompleted.count).toBeGreaterThan(0);
  });

  it('counts failed Jev attempts against the per-run execution cap', async () => {
    const { JEV_PROCESS_JOB_TYPE, runDueJobs } = await import('./job-queue');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-jev-fail-cap', 'https://example.com/fail-cap', now, now);
    const insertArticle = db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertJob = db.prepare(
      'INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, scheduled_at, created_at) VALUES (?, ?, ?, ?, 0, 4, ?, ?)',
    );
    for (let index = 1; index <= 8; index += 1) {
      const articleId = `jev-fail-cap-${index}`;
      insertArticle.run(
        articleId,
        'feed-jev-fail-cap',
        `https://example.com/fail-cap/${index}`,
        `Failing Jev article ${index}`,
        now + index,
        now + index,
        now + index,
      );
      insertJob.run(
        `job-${articleId}`,
        JEV_PROCESS_JOB_TYPE,
        'queued',
        JSON.stringify({ articleId }),
        now - 1,
        now - 100 + index,
      );
    }
    jevMocks.processJevArticle.mockRejectedValue(
      new Error('provider unavailable'),
    );

    const result = await runDueJobs({ now, maxJobs: 24 });
    const jobs = db
      .prepare('SELECT status, attempts FROM jobs WHERE type = ? ORDER BY id')
      .all(JEV_PROCESS_JOB_TYPE) as Array<{
      status: string;
      attempts: number;
    }>;

    expect(result.processed).toBe(4);
    expect(result.retried).toBe(4);
    expect(jevMocks.processJevArticle).toHaveBeenCalledTimes(4);
    expect(jobs.filter(({ attempts }) => attempts === 1)).toHaveLength(4);
    expect(jobs.filter(({ attempts }) => attempts === 0)).toHaveLength(4);
  });
});
