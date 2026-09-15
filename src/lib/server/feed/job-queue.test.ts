import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

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
});
