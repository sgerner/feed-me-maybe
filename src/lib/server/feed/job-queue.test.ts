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
  isRankingProviderConfigured: vi.fn(() => true),
  processJevArticle: vi.fn(async () => undefined),
}));
const aiMocks = vi.hoisted(() => ({
  processArticle: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock('#lib/server/ai/jev.ts', () => jevMocks);
vi.mock('#lib/server/ai/processor.ts', () => aiMocks);

describe('feed job queue', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-feed-job-queue.db');
  const originalDbUrl = process.env.DATABASE_URL;
  const originalAppSecret = process.env.APP_SECRET;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbPath;
    process.env.APP_SECRET = 'test-app-secret-which-is-at-least-32-characters';
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const { initializeDatabase } = await import('#lib/server/db/migrate.ts');
    initializeDatabase();
  });

  beforeEach(async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    db.prepare('DELETE FROM feed_fetch_logs').run();
    db.prepare('DELETE FROM jobs').run();
    db.prepare('DELETE FROM feeds').run();
    db.prepare('DELETE FROM app_error_logs').run();
    db.prepare('DELETE FROM provider_configs').run();
    db.prepare(
      "DELETE FROM app_settings WHERE key LIKE 'provider_cooldown_%' OR key = 'ai_enabled'",
    ).run();
    const { encrypt } = await import('#lib/server/ai/crypto.ts');
    const creds = encrypt(JSON.stringify({ apiKey: 'test-ai-key' }));
    db.prepare(
      'INSERT INTO provider_configs (id, provider_id, model_id, api_key_encrypted, api_key_nonce, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(
      'test-ai-cfg',
      'test-provider',
      'test-model',
      creds.encrypted,
      creds.nonce,
      Date.now(),
      Date.now(),
    );
    jevMocks.isRankingProviderConfigured.mockReturnValue(true);
    jevMocks.processJevArticle.mockReset().mockResolvedValue(undefined);
    aiMocks.processArticle.mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    const { closeDb } = await import('#lib/server/db/index.ts');
    closeDb();
    process.env.DATABASE_URL = originalDbUrl ?? '';
    if (originalAppSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = originalAppSecret;
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

    const { getDb } = await import('#lib/server/db/index.ts');
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
    expect(JSON.parse(row.payload).force).toBe(true);
  });

  it('leaves queued AI work paused until background processing is re-enabled', async () => {
    const { enqueueAiProcess, getNextQueuedJobAt, getJob, runDueJobs } =
      await import('./job-queue');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = Date.now();
    const job = enqueueAiProcess('paused-ai-article', { now });
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('ai_enabled', 'false', ?)
       ON CONFLICT(key) DO UPDATE SET value = 'false', updated_at = excluded.updated_at`,
    ).run(now);

    expect(getNextQueuedJobAt()).toBeNull();
    expect(await runDueJobs({ now, maxJobs: 1 })).toMatchObject({
      processed: 0,
      completed: 0,
    });
    expect(getJob(job.id)).toMatchObject({
      status: 'queued',
      attempts: 0,
    });
    expect(aiMocks.processArticle).not.toHaveBeenCalled();

    db.prepare(
      `UPDATE app_settings SET value = 'true', updated_at = ? WHERE key = 'ai_enabled'`,
    ).run(now + 1);
    expect(await runDueJobs({ now: now + 1, maxJobs: 1 })).toMatchObject({
      processed: 1,
      completed: 1,
    });
    expect(aiMocks.processArticle).toHaveBeenCalledWith('paused-ai-article');
  });

  it('runs a bounded set of feed fetches concurrently', async () => {
    const { enqueueFeedFetch, runDueJobs } = await import('./job-queue');
    const ingester = await import('./ingester');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ingest = vi
      .spyOn(ingester, 'ingestFeed')
      .mockImplementation(async () => {
        await gate;
        return { success: true, articlesFound: 0, articlesNew: 0 };
      });
    for (const id of ['one', 'two', 'three', 'four']) enqueueFeedFetch(id);
    const result = runDueJobs({ maxJobs: 4 });
    try {
      await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(3));
    } finally {
      release();
      await result;
      ingest.mockRestore();
    }
    expect(await result).toMatchObject({ processed: 4, completed: 4 });
  });

  it('claims the requested feed job ahead of older unrelated work', async () => {
    const { enqueueFeedFetch, getJob, runDueJobs } =
      await import('./job-queue');
    const ingester = await import('./ingester');
    const ingest = vi.spyOn(ingester, 'ingestFeed').mockResolvedValue({
      success: true,
      articlesFound: 0,
      articlesNew: 0,
    });
    try {
      enqueueFeedFetch('older-unrelated', { now: 10_000 });
      const requested = enqueueFeedFetch('requested-feed', { now: 20_000 });

      await runDueJobs({ now: 30_000, maxJobs: 1, jobId: requested.id });

      expect(ingest).toHaveBeenCalledTimes(1);
      expect(ingest).toHaveBeenCalledWith(
        expect.objectContaining({ feedId: 'requested-feed' }),
      );
      expect(getJob(requested.id)?.status).toBe('completed');
      expect(getJob(enqueueFeedFetch('older-unrelated').id)?.status).toBe(
        'queued',
      );
    } finally {
      ingest.mockRestore();
    }
  });

  it('starts a refresh while an active one-job batch is waiting on scoring', async () => {
    const { enqueueAiProcess, enqueueFeedFetch, runDueJobs } =
      await import('./job-queue');
    const ingester = await import('./ingester');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    aiMocks.processArticle.mockImplementation(() => gate);
    const ingest = vi.spyOn(ingester, 'ingestFeed').mockResolvedValue({
      success: true,
      articlesFound: 0,
      articlesNew: 0,
    });
    enqueueAiProcess('pending-article');
    const batch = runDueJobs({ maxJobs: 1 });
    try {
      await vi.waitFor(() =>
        expect(aiMocks.processArticle).toHaveBeenCalledTimes(1),
      );
      enqueueFeedFetch('critical-refresh');
      expect(runDueJobs({ maxJobs: 1 })).toBe(batch);
      await vi.waitFor(() =>
        expect(ingest).toHaveBeenCalledWith(
          expect.objectContaining({ feedId: 'critical-refresh' }),
        ),
      );
    } finally {
      release();
      await batch;
      ingest.mockRestore();
    }
    expect(await batch).toMatchObject({ processed: 2, completed: 2 });
  });

  it('keeps an upstream retry deadline and stops permanent feed failures', async () => {
    const { enqueueFeedFetch, runDueJobs, getJob } =
      await import('./job-queue');
    const ingester = await import('./ingester');
    const retryAt = Date.now() + 120_000;
    const ingest = vi
      .spyOn(ingester, 'ingestFeed')
      .mockResolvedValueOnce({
        success: false,
        articlesFound: 0,
        articlesNew: 0,
        error: 'Rate limited',
        retryAt,
      })
      .mockResolvedValueOnce({
        success: false,
        articlesFound: 0,
        articlesNew: 0,
        error: 'Gone',
        permanentFailure: true,
      });
    try {
      const limited = enqueueFeedFetch('limited');
      expect((await runDueJobs({ maxJobs: 1 })).retried).toBe(1);
      expect(enqueueFeedFetch('limited').scheduledAt).toBe(retryAt);
      expect(enqueueFeedFetch('limited', { force: true }).scheduledAt).toBe(
        retryAt,
      );
      expect(getJob(limited.id)?.status).toBe('queued');

      const removed = enqueueFeedFetch('removed');
      expect((await runDueJobs({ maxJobs: 1 })).failed).toBe(1);
      expect(getJob(removed.id)).toMatchObject({
        status: 'failed',
        attempts: 1,
      });
    } finally {
      ingest.mockRestore();
    }
  });

  it.each([401, 429] as const)(
    'pauses the affected scoring lane after HTTP %s',
    async (status) => {
      const { enqueueAiProcess, runDueJobs, getJob, getNextQueuedJobAt } =
        await import('./job-queue');
      const { ProviderHttpError } =
        await import('#lib/server/ai/provider-error.ts');
      const retryAt = Date.now() + 120_000;
      aiMocks.processArticle.mockRejectedValueOnce(
        new Error('Wrapped request failure', {
          cause: new ProviderHttpError(
            'Provider rejected request',
            status,
            retryAt,
          ),
        }),
      );
      const first = enqueueAiProcess('one');
      const second = enqueueAiProcess('two');
      await runDueJobs({ maxJobs: 4 });

      expect(aiMocks.processArticle).toHaveBeenCalledTimes(1);
      expect(getJob(first.id)).toMatchObject({
        status: status === 401 ? 'failed' : 'queued',
        attempts: 1,
      });
      expect(getJob(second.id)).toMatchObject({
        status: 'queued',
        attempts: 0,
      });
      expect(getNextQueuedJobAt()).toBe(retryAt);
      expect((await runDueJobs({ maxJobs: 4 })).processed).toBe(0);
    },
  );

  it('recovers abandoned processing jobs and fetch logs', async () => {
    const { FEED_FETCH_LEASE_MS, recoverAbandonedJobs } =
      await import('./job-queue');
    const { getDb } = await import('#lib/server/db/index.ts');
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
    const { getDb } = await import('#lib/server/db/index.ts');
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
    const { getDb } = await import('#lib/server/db/index.ts');
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

  it('waits for active enrichment and skips archived articles during backfill', async () => {
    const {
      AI_PROCESS_JOB_TYPE,
      enqueueJevBackfill,
      enqueueJevProcess,
      JEV_PROCESS_JOB_TYPE,
    } = await import('./job-queue');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = 55_000;

    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-ai-backfill', 'https://example.com/ai-backfill', now, now);

    const article = db.prepare(
      `INSERT INTO articles
         (id, feed_id, url, title, hidden, rejected, jev_score, fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    );
    for (const [id, hidden, rejected] of [
      ['ai-queued', 0, 0],
      ['ai-processing', 0, 0],
      ['ai-failed', 0, 0],
      ['hidden-archive', 1, 0],
      ['rejected-archive', 0, 1],
      ['visible-article', 0, 0],
    ] as const) {
      article.run(
        id,
        'feed-ai-backfill',
        `https://example.com/${id}`,
        id,
        hidden,
        rejected,
        now,
        now,
        now,
      );
    }

    const insertJob = db.prepare(
      'INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, created_at) VALUES (?, ?, ?, ?, 0, 4, ?)',
    );
    insertJob.run(
      'ai-queued-job',
      AI_PROCESS_JOB_TYPE,
      'queued',
      JSON.stringify({ articleId: 'ai-queued' }),
      now,
    );
    insertJob.run(
      'ai-processing-job',
      AI_PROCESS_JOB_TYPE,
      'processing',
      JSON.stringify({ articleId: 'ai-processing' }),
      now,
    );
    insertJob.run(
      'ai-failed-job',
      AI_PROCESS_JOB_TYPE,
      'failed',
      JSON.stringify({ articleId: 'ai-failed' }),
      now,
    );

    expect(enqueueJevProcess('hidden-archive', { now })).toBeNull();
    expect(enqueueJevProcess('rejected-archive', { now })).toBeNull();
    expect(enqueueJevBackfill({ now, limit: 10 })).toBe(2);
    const queuedIds = db
      .prepare(
        `SELECT json_extract(payload, '$.articleId') AS article_id
         FROM jobs WHERE type = ? AND status = 'queued'
         ORDER BY article_id`,
      )
      .all(JEV_PROCESS_JOB_TYPE) as Array<{ article_id: string }>;
    expect(queuedIds.map((row) => row.article_id)).toEqual([
      'ai-failed',
      'visible-article',
    ]);
  });

  it('backfills active AI articles while AI processing is disabled', async () => {
    const { AI_PROCESS_JOB_TYPE, enqueueJevBackfill, JEV_PROCESS_JOB_TYPE } =
      await import('./job-queue');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = 60_000;

    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-ai-paused', 'https://example.com/ai-paused', now, now);
    db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'ai-paused-article',
      'feed-ai-paused',
      'https://example.com/ai-paused/article',
      'Paused enrichment',
      now,
      now,
      now,
    );
    db.prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('ai_enabled', 'false', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(now);
    db.prepare(
      'INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, created_at) VALUES (?, ?, ?, ?, 0, 4, ?)',
    ).run(
      'ai-paused-job',
      AI_PROCESS_JOB_TYPE,
      'queued',
      JSON.stringify({ articleId: 'ai-paused-article' }),
      now,
    );

    expect(enqueueJevBackfill({ now })).toBe(1);
    expect(
      db
        .prepare(
          "SELECT status FROM jobs WHERE type = ? AND json_extract(payload, '$.articleId') = ?",
        )
        .get(JEV_PROCESS_JOB_TYPE, 'ai-paused-article'),
    ).toEqual({ status: 'queued' });
  });

  it('allows one cooled down recovery for a failed Jev backfill', async () => {
    const { enqueueJevBackfill, JEV_PROCESS_JOB_TYPE } =
      await import('./job-queue');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = 10_000_000;
    const cooldown = 60 * 60 * 1000;

    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-jev-recovery', 'https://example.com/jev-recovery', now, now);
    db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'jev-recovery-article',
      'feed-jev-recovery',
      'https://example.com/jev-recovery/article',
      'Failed enrichment',
      now,
      now,
      now,
    );
    db.prepare(
      'INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, created_at, completed_at) VALUES (?, ?, ?, ?, 4, 4, ?, ?)',
    ).run(
      'jev-original-failure',
      JEV_PROCESS_JOB_TYPE,
      'failed',
      JSON.stringify({ articleId: 'jev-recovery-article', backfill: true }),
      now - cooldown - 1,
      now - cooldown - 1,
    );

    expect(enqueueJevBackfill({ now })).toBe(1);
    const recovery = db
      .prepare(
        "SELECT id, payload FROM jobs WHERE type = ? AND status = 'queued' AND json_extract(payload, '$.articleId') = ?",
      )
      .get(JEV_PROCESS_JOB_TYPE, 'jev-recovery-article') as {
      id: string;
      payload: string;
    };
    expect(JSON.parse(recovery.payload)).toMatchObject({
      articleId: 'jev-recovery-article',
      backfill: true,
      backfillRecovery: true,
    });

    db.prepare(
      "UPDATE jobs SET status = 'failed', completed_at = ? WHERE id = ?",
    ).run(now, recovery.id);
    expect(enqueueJevBackfill({ now: now + cooldown + 1 })).toBe(0);
  });

  it('bounds Jev backfill to four active jobs and deduplicates repeated runs', async () => {
    const { enqueueJevBackfill, JEV_PROCESS_JOB_TYPE } =
      await import('./job-queue');
    const { getDb } = await import('#lib/server/db/index.ts');
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
      .prepare(
        "SELECT json_extract(payload, '$.articleId') AS id FROM jobs WHERE type = ? ORDER BY id",
      )
      .all(JEV_PROCESS_JOB_TYPE);
    expect(jobs).toEqual([
      { id: 'jev-bound-3' },
      { id: 'jev-bound-4' },
      { id: 'jev-bound-5' },
      { id: 'jev-bound-6' },
    ]);
  });

  it('recovers expired Jev leases and fails jobs that exhausted their attempts', async () => {
    const { JEV_PROCESS_LEASE_MS, recoverAbandonedJobs } =
      await import('./job-queue');
    const { getDb } = await import('#lib/server/db/index.ts');
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
    const { getDb } = await import('#lib/server/db/index.ts');
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
    const { getDb } = await import('#lib/server/db/index.ts');
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
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = Date.now();
    jevMocks.isRankingProviderConfigured.mockReturnValue(false);
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
    const { getDb } = await import('#lib/server/db/index.ts');
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
    const { getDb } = await import('#lib/server/db/index.ts');
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

  it('preserves retry backoff on feedback wakeups, skips unconfigured AI, and enforces permanent truncations', async () => {
    const {
      enqueueAiProcess,
      enqueueJevProcess,
      getJob,
      getNextQueuedJobAt,
      runDueJobs,
      AI_PROCESS_JOB_TYPE,
      JEV_PROCESS_JOB_TYPE,
    } = await import('./job-queue');
    const { AiTruncationError } = await import('#lib/server/ai/client.ts');
    const { ProviderHttpError } =
      await import('#lib/server/ai/provider-error.ts');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = Date.now();
    const backoffAt = now + 90_000;

    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-backoff', 'https://example.com/backoff', now, now);
    db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'backoff-article',
      'feed-backoff',
      'https://example.com/backoff/1',
      'Backoff article',
      now,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, scheduled_at, created_at)
       VALUES ('jev-backoff', ?, 'queued', ?, 1, 4, ?, ?)`,
    ).run(
      JEV_PROCESS_JOB_TYPE,
      JSON.stringify({ articleId: 'backoff-article' }),
      backoffAt,
      now - 1000,
    );

    const woken = enqueueJevProcess('backoff-article', { feedback: true, now });
    expect(woken?.scheduledAt).toBe(backoffAt);

    const retryAt = now + 45_000;
    jevMocks.processJevArticle.mockRejectedValueOnce(
      new ProviderHttpError('Too many requests', 429, retryAt),
    );
    db.prepare('UPDATE jobs SET scheduled_at = ? WHERE id = ?').run(
      now - 1,
      'jev-backoff',
    );
    await runDueJobs({ now, maxJobs: 1 });
    expect(getJob('jev-backoff')?.result).toEqual({ retryAt });

    db.prepare('DELETE FROM provider_configs').run();
    const unconfiguredAi = enqueueAiProcess('unconfigured-ai', { now });
    expect(getNextQueuedJobAt()).toBeGreaterThanOrEqual(
      Math.max(now + 60_000, retryAt),
    );
    expect(getNextQueuedJobAt()).toBeLessThanOrEqual(Date.now() + 60_000);
    await runDueJobs({ now, maxJobs: 1 });
    expect(getJob(unconfiguredAi.id)?.status).toBe('queued');
    expect(aiMocks.processArticle).not.toHaveBeenCalled();

    const { encrypt } = await import('#lib/server/ai/crypto.ts');
    const creds = encrypt(JSON.stringify({ apiKey: 'test-ai-key' }));
    db.prepare(
      'INSERT INTO provider_configs (id, provider_id, model_id, api_key_encrypted, api_key_nonce, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(
      'restored-ai',
      'test-provider',
      'test-model',
      creds.encrypted,
      creds.nonce,
      now,
      now,
    );
    aiMocks.processArticle.mockRejectedValueOnce(
      new AiTruncationError('Truncated completion'),
    );
    await runDueJobs({ now, maxJobs: 1 });
    expect(getJob(unconfiguredAi.id)).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
    expect(AI_PROCESS_JOB_TYPE).toBe('ai_process');
  });

  it('prevents poller spins at Jev capacity and prunes sessions and non-backfill ranking jobs', async () => {
    const {
      DEFAULT_JEV_QUEUE_CAPACITY,
      enqueueJevProcess,
      getNextQueuedJobAt,
      JEV_PROCESS_JOB_TYPE,
    } = await import('./job-queue');
    const { pruneOperationalHistory } = await import('#lib/server/logging.ts');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = Date.now();
    const old = now - 31 * 24 * 60 * 60 * 1000;

    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-cap', 'https://example.com/cap', now, now);
    for (let i = 0; i <= DEFAULT_JEV_QUEUE_CAPACITY; i += 1) {
      db.prepare(
        'INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        `cap-${i}`,
        'feed-cap',
        `https://example.com/cap/${i}`,
        `Cap ${i}`,
        now,
        now,
        now,
      );
      if (i < DEFAULT_JEV_QUEUE_CAPACITY) {
        const j = enqueueJevProcess(`cap-${i}`, { now })!;
        db.prepare('UPDATE jobs SET scheduled_at = ? WHERE id = ?').run(
          now + 60_000,
          j.id,
        );
      }
    }
    db.prepare(
      `INSERT INTO ranking_refresh_queue (article_id, requested_revision, heuristic_revision, not_before, created_at)
       VALUES (?, 1, 1, ?, ?)`,
    ).run(`cap-${DEFAULT_JEV_QUEUE_CAPACITY}`, now - 5_000, now - 5_000);

    // Must wait on future Jev job instead of spinning immediately on full capacity.
    expect(getNextQueuedJobAt()).toBe(now + 60_000);

    db.prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).run('expired-sess', 'admin', old, now - 1);
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, completed_at, created_at)
       VALUES ('old-feedback-jev', ?, 'completed', ?, 1, 4, ?, ?),
              ('old-backfill-tombstone', ?, 'completed', ?, 1, 4, ?, ?)`,
    ).run(
      JEV_PROCESS_JOB_TYPE,
      JSON.stringify({ articleId: 'cap-0', feedback: true }),
      old,
      old,
      JEV_PROCESS_JOB_TYPE,
      JSON.stringify({ articleId: 'cap-0', backfill: true }),
      old,
      old,
    );

    pruneOperationalHistory(now);

    expect(
      db.prepare('SELECT id FROM sessions WHERE id = ?').get('expired-sess'),
    ).toBeUndefined();
    expect(
      db.prepare('SELECT id FROM jobs WHERE id = ?').get('old-feedback-jev'),
    ).toBeUndefined();
    expect(
      db
        .prepare('SELECT id FROM jobs WHERE id = ?')
        .get('old-backfill-tombstone'),
    ).toBeDefined();
  });

  it('skips paused feeds when enqueueing or executing AI and Jev jobs', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const {
      enqueueAiProcess,
      enqueueAiBackfill,
      enqueueJevProcess,
      enqueueJevBackfill,
      runDueJobs,
      getJob,
    } = await import('./job-queue');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, title, enabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    ).run(
      'feed-paused-jq',
      'https://paused-jq.example.com/rss',
      'Paused',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, summary, content, fetched_at, created_at, updated_at)
       VALUES ('paused-jq-art', 'feed-paused-jq', 'https://paused-jq.example.com/1', 'Paused Art', 'Summary text long enough', 'Detailed body content long enough for AI analysis.', ?, ?, ?)`,
    ).run(now, now, now);

    expect(enqueueJevProcess('paused-jq-art', { now })).toBeNull();
    expect(enqueueJevBackfill({ now })).toBe(0);
    expect(enqueueAiBackfill({ now })).toBe(0);

    // Pre-existing queued jobs for paused feed are skipped cleanly at execution
    const queuedAi = enqueueAiProcess('paused-jq-art', { now })!;
    expect(queuedAi).toBeTruthy();
    await runDueJobs({ now: now + 1, maxJobs: 5 });
    expect(aiMocks.processArticle).not.toHaveBeenCalledWith('paused-jq-art');
    expect(getJob(queuedAi.id)?.status).toBe('completed');
  });

  it('separates feed budget from AI/Jev budget and prioritizes fresh feed fetches over retries', async () => {
    const {
      enqueueAiProcess,
      enqueueFeedFetch,
      FEED_FETCH_JOB_TYPE,
      getJob,
      runDueJobs,
    } = await import('./job-queue');
    const ingester = await import('./ingester');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = 1_000_000;

    const fetchedOrder: string[] = [];
    const ingest = vi
      .spyOn(ingester, 'ingestFeed')
      .mockImplementation(async ({ feedId }) => {
        fetchedOrder.push(feedId);
        return { success: true, articlesFound: 0, articlesNew: 0 };
      });

    try {
      for (let i = 1; i <= 5; i += 1) {
        enqueueAiProcess(`ai-starve-${i}`, { now: now - 500 + i });
      }
      // Older retry job (attempts = 1) vs newer fresh job (attempts = 0)
      db.prepare(
        `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, scheduled_at, created_at)
         VALUES ('retry-feed', ?, 'queued', ?, 1, 4, ?, ?)`,
      ).run(
        FEED_FETCH_JOB_TYPE,
        JSON.stringify({ feedId: 'feed-retry' }),
        now - 10_000,
        now - 10_000,
      );
      const fresh = enqueueFeedFetch('feed-fresh', { now });

      // Budget = 2 allows 2 feed jobs AND 2 scoring jobs without AI starving feeds.
      await runDueJobs({ now, maxJobs: 2 });

      expect(fetchedOrder).toEqual(['feed-fresh', 'feed-retry']);
      expect(getJob(fresh.id)?.status).toBe('completed');
      expect(getJob('retry-feed')?.status).toBe('completed');
      expect(aiMocks.processArticle).toHaveBeenCalledTimes(2);
    } finally {
      ingest.mockRestore();
    }
  });

  it('completes feed_fetch jobs for disabled feeds without ingesting', async () => {
    const { enqueueFeedFetch, getJob, runDueJobs } =
      await import('./job-queue');
    const ingester = await import('./ingester');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = 1_100_000;

    db.prepare(
      'INSERT INTO feeds (id, url, enabled, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
    ).run('feed-disabled-fetch', 'https://disabled.example/rss', now, now);

    const ingest = vi.spyOn(ingester, 'ingestFeed').mockResolvedValue({
      success: true,
      articlesFound: 0,
      articlesNew: 0,
    });
    try {
      const job = enqueueFeedFetch('feed-disabled-fetch', { now });
      await runDueJobs({ now, maxJobs: 1 });
      expect(ingest).not.toHaveBeenCalled();
      expect(getJob(job.id)?.status).toBe('completed');
      expect(getJob(job.id)?.result).toMatchObject({ skipped: true });
    } finally {
      ingest.mockRestore();
    }
  });

  it('reclaims interrupted processing jobs immediately on startup without waiting for lease expiry', async () => {
    const { reclaimInterruptedProcessingJobs, getJob } =
      await import('./job-queue');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = 5_000_000;

    db.prepare(
      "INSERT INTO feeds (id, url, last_fetch_status, created_at, updated_at) VALUES (?, ?, 'fetching', ?, ?)",
    ).run('feed-startup', 'https://startup.example/rss', now, now);
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, started_at, created_at)
       VALUES ('startup-feed', 'feed_fetch', 'processing', ?, 1, 4, ?, ?),
              ('startup-ai', 'ai_process', 'processing', ?, 1, 3, ?, ?),
              ('startup-exhausted', 'jev_process', 'processing', ?, 4, 4, ?, ?)`,
    ).run(
      JSON.stringify({ feedId: 'feed-startup' }),
      now - 500,
      now - 500,
      JSON.stringify({ articleId: 'art-startup' }),
      now - 500,
      now - 500,
      JSON.stringify({ articleId: 'art-exhausted' }),
      now - 500,
      now - 500,
    );
    db.prepare(
      "INSERT INTO feed_fetch_logs (id, feed_id, status, started_at, created_at) VALUES ('startup-log', 'feed-startup', 'fetching', ?, ?)",
    ).run(now - 500, now - 500);

    const recovered = reclaimInterruptedProcessingJobs(now);
    expect(recovered).toEqual({
      jobsRequeued: 2,
      jobsFailed: 1,
      fetchLogsRecovered: 1,
    });
    expect(getJob('startup-feed')).toMatchObject({
      status: 'queued',
      scheduledAt: now,
      startedAt: null,
    });
    expect(getJob('startup-ai')).toMatchObject({
      status: 'queued',
      scheduledAt: now,
      startedAt: null,
    });
    expect(getJob('startup-exhausted')).toMatchObject({
      status: 'failed',
      completedAt: now,
      startedAt: null,
    });
    const log = db
      .prepare('SELECT status FROM feed_fetch_logs WHERE id = ?')
      .get('startup-log') as { status: string };
    expect(log.status).toBe('error');
    const feed = db
      .prepare('SELECT error_count, last_fetch_status FROM feeds WHERE id = ?')
      .get('feed-startup') as {
      error_count: number;
      last_fetch_status: string;
    };
    expect(feed.error_count).toBe(0);
    expect(feed.last_fetch_status).toBe('never');
  });

  it('does not copy 30-day-old errors in recoverAbandonedJobs and records missing/exhausted crash errors', async () => {
    const { FEED_FETCH_LEASE_MS, recoverAbandonedJobs } =
      await import('./job-queue');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = 50_000_000;
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const jobStart = now - FEED_FETCH_LEASE_MS - 1_000;

    db.prepare(
      "INSERT INTO feeds (id, url, last_fetch_status, error_count, last_error, created_at, updated_at) VALUES (?, ?, 'success', 0, '', ?, ?)",
    ).run('feed-old-err', 'https://olderr.example/rss', thirtyDaysAgo, now);

    db.prepare(
      "INSERT INTO feed_fetch_logs (id, feed_id, status, error_message, started_at, completed_at, created_at) VALUES ('old-err', 'feed-old-err', 'error', '30-day-old TLS failure', ?, ?, ?), ('recent-ok', 'feed-old-err', 'success', NULL, ?, ?, ?)",
    ).run(
      thirtyDaysAgo,
      thirtyDaysAgo + 100,
      thirtyDaysAgo,
      oneDayAgo,
      oneDayAgo + 100,
      oneDayAgo,
    );

    // Crashed before writing a fetch log row
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, started_at, created_at)
       VALUES ('crashed-no-log', 'feed_fetch', 'processing', ?, 1, 4, ?, ?)`,
    ).run(JSON.stringify({ feedId: 'feed-old-err' }), jobStart, jobStart);

    recoverAbandonedJobs(now);

    const feed = db
      .prepare(
        'SELECT error_count, last_fetch_status, last_error FROM feeds WHERE id = ?',
      )
      .get('feed-old-err') as {
      error_count: number;
      last_fetch_status: string;
      last_error: string;
    };
    expect(feed.error_count).toBe(1);
    expect(feed.last_fetch_status).toBe('error');
    expect(feed.last_error).not.toContain('30-day-old TLS failure');
    expect(feed.last_error).toContain('lease expired');
  });

  it('includes per-feed poll intervals and processing lease expirations in getNextQueuedJobAt', async () => {
    const { FEED_FETCH_LEASE_MS, getNextQueuedJobAt } =
      await import('./job-queue');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = 60_000_000;

    db.prepare(
      'INSERT INTO feeds (id, url, enabled, poll_interval_mins, last_fetch_at, created_at, updated_at) VALUES (?, ?, 1, 3, ?, ?, ?)',
    ).run('feed-custom-poll', 'https://custompoll.example/rss', now, now, now);

    expect(getNextQueuedJobAt(now)).toBe(now + 3 * 60_000);

    const startedAt = now + 1_000;
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, started_at, created_at)
       VALUES ('lease-check', 'feed_fetch', 'processing', ?, 1, 4, ?, ?)`,
    ).run(JSON.stringify({ feedId: 'feed-other' }), startedAt, startedAt);

    // Custom poll (3m) is earlier than lease (10m)
    expect(getNextQueuedJobAt(now)).toBe(now + 3 * 60_000);

    // When feed poll is 30m, 10m processing lease expiry is earlier
    db.prepare('UPDATE feeds SET poll_interval_mins = 30 WHERE id = ?').run(
      'feed-custom-poll',
    );
    expect(getNextQueuedJobAt(now)).toBe(startedAt + FEED_FETCH_LEASE_MS);
  });

  it('queues a successor job when force: true arrives during an in-flight processing fetch', async () => {
    const { enqueueFeedFetch, getJob, runDueJobs } =
      await import('./job-queue');
    const ingester = await import('./ingester');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = 70_000_000;

    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, started_at, created_at)
       VALUES ('in-flight', 'feed_fetch', 'processing', ?, 1, 4, ?, ?)`,
    ).run(JSON.stringify({ feedId: 'feed-inflight' }), now, now);

    // Non-forced poll deduplicates onto the processing job
    expect(enqueueFeedFetch('feed-inflight', { now: now + 100 }).id).toBe(
      'in-flight',
    );

    // Forced refresh / URL edit creates a queued successor
    const successor = enqueueFeedFetch('feed-inflight', {
      force: true,
      now: now + 200,
    });
    expect(successor.id).not.toBe('in-flight');
    expect(successor.status).toBe('queued');

    // A second forced call deduplicates onto the queued successor
    const secondForce = enqueueFeedFetch('feed-inflight', {
      force: true,
      now: now + 300,
    });
    expect(secondForce.id).toBe(successor.id);

    // While 'in-flight' is still processing, runDueJobs must NOT claim the successor
    const ingest = vi.spyOn(ingester, 'ingestFeed').mockResolvedValue({
      success: true,
      articlesFound: 0,
      articlesNew: 0,
    });
    try {
      await runDueJobs({ now: now + 400, maxJobs: 2 });
      expect(ingest).not.toHaveBeenCalled();
      expect(getJob(successor.id)?.status).toBe('queued');

      // Once 'in-flight' finishes, the successor runs cleanly
      db.prepare(
        "UPDATE jobs SET status = 'completed', started_at = NULL, completed_at = ? WHERE id = 'in-flight'",
      ).run(now + 500);
      await runDueJobs({ now: now + 600, maxJobs: 2 });
      expect(ingest).toHaveBeenCalledTimes(1);
      expect(getJob(successor.id)?.status).toBe('completed');
    } finally {
      ingest.mockRestore();
    }
  });
});
