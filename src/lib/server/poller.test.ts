import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createTestDb, type TestDbHandle } from '#lib/server/db/test-db.ts';

describe('poller scheduling and startup reclaim', () => {
  let testDb: TestDbHandle;

  beforeAll(() => {
    testDb = createTestDb('feed-me-maybe-poller-');
  });

  beforeEach(() => {
    vi.useFakeTimers();
    testDb.reset();
    testDb.db
      .prepare(
        "UPDATE app_settings SET value = '60' WHERE key = 'poll_interval_mins'",
      )
      .run();
  });

  afterEach(async () => {
    const { stopPolling } = await import('./poller');
    stopPolling();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  it('runs one-time startup reclaim when polling starts', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { startPolling } = await import('./poller');
    const { getJob } = await import('#lib/server/feed/job-queue.ts');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
    ).run('feed-boot', 'https://boot.example/rss', now, now);
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, started_at, created_at)
       VALUES ('boot-job', 'feed_fetch', 'processing', ?, 1, 4, ?, ?)`,
    ).run(JSON.stringify({ feedId: 'feed-boot' }), now - 100, now - 100);

    startPolling();

    expect(getJob('boot-job')?.status).toBe('queued');
  });

  it('preserves mid-cycle wakePoller requests when the active cycle finishes', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { startPolling, wakePoller, scheduleNextPoll } =
      await import('./poller');
    const ingester = await import('#lib/server/feed/ingester.ts');
    const db = getDb();
    const now = Date.now();

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetched: string[] = [];
    const ingest = vi
      .spyOn(ingester, 'ingestFeed')
      .mockImplementation(async ({ feedId }) => {
        fetched.push(feedId);
        if (feedId === 'feed-slow') {
          await firstGate;
        }
        return { success: true, articlesFound: 0, articlesNew: 0 };
      });

    db.prepare(
      'INSERT INTO feeds (id, url, enabled, last_fetch_at, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)',
    ).run('feed-slow', 'https://slow.example/rss', null, now, now);

    startPolling();

    // Advance 1s to fire the initial poll cycle, which gets blocked in feed-slow
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetched).toEqual(['feed-slow']);

    // Mid-cycle: user adds a feed and calls wakePoller()
    db.prepare(
      'INSERT INTO feeds (id, url, enabled, last_fetch_at, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)',
    ).run('feed-midcycle', 'https://midcycle.example/rss', null, now, now);
    wakePoller();

    // Also verify scheduleNextPoll() without delay doesn't overwrite the 1s wake timer
    scheduleNextPoll();

    // Finish the slow cycle
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);

    // The preserved 1s wakeup fires and processes feed-midcycle without waiting 60m!
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetched).toContain('feed-midcycle');
    ingest.mockRestore();
  });

  it('respects per-feed poll_interval_mins for next wakeup without resetting earlier timer', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { startPolling, scheduleNextPoll } = await import('./poller');
    const ingester = await import('#lib/server/feed/ingester.ts');
    const db = getDb();
    const now = Date.now();

    const fetched: string[] = [];
    vi.spyOn(ingester, 'ingestFeed').mockImplementation(async ({ feedId }) => {
      fetched.push(feedId);
      db.prepare('UPDATE feeds SET last_fetch_at = ? WHERE id = ?').run(
        Date.now(),
        feedId,
      );
      return { success: true, articlesFound: 0, articlesNew: 0 };
    });

    // Global interval is 60m, but feed has 2m custom interval
    db.prepare(
      'INSERT INTO feeds (id, url, enabled, poll_interval_mins, last_fetch_at, created_at, updated_at) VALUES (?, ?, 1, 2, ?, ?, ?)',
    ).run('feed-2m', 'https://two-min.example/rss', now, now, now);

    startPolling();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetched).toEqual([]);

    // Reschedule without args should keep ~2m wakeup, not 60m
    scheduleNextPoll();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(fetched).toEqual(['feed-2m']);
  });
});
