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

const testDbPath = join(process.cwd(), 'data', 'test-ranking-freshness.db');
const originalDbUrl = process.env.DATABASE_URL;
const originalJevKey = process.env.JEV_API_KEY;
const originalTypesafeKey = process.env.TYPESAFE_API_KEY;
const originalSubqKey = process.env.SUBQ_API_KEY;

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]),
  },
}));

describe('ranking freshness after explicit feedback', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = testDbPath;
    if (!existsSync(join(process.cwd(), 'data')))
      mkdirSync(join(process.cwd(), 'data'));
    const { initializeDatabase } = await import('$lib/server/db/migrate');
    initializeDatabase();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    process.env.JEV_API_KEY = 'test-jev-key';
    process.env.TYPESAFE_API_KEY = '';
    process.env.SUBQ_API_KEY = '';
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    db.prepare('DELETE FROM ranking_refresh_queue').run();
    db.prepare('DELETE FROM jobs').run();
    db.prepare('DELETE FROM user_interactions').run();
    db.prepare('DELETE FROM user_preference_memory').run();
    db.prepare('DELETE FROM articles').run();
    db.prepare('DELETE FROM feeds').run();
    db.prepare(
      "DELETE FROM app_settings WHERE key = 'ranking_feedback_revision'",
    ).run();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('fresh-feed', 'https://example.com/fresh.xml', 'Fresh', now, now);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    const { closeDb } = await import('$lib/server/db');
    closeDb();
    process.env.DATABASE_URL = originalDbUrl ?? '';
    if (originalJevKey === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = originalJevKey;
    if (originalTypesafeKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalTypesafeKey;
    if (originalSubqKey === undefined) delete process.env.SUBQ_API_KEY;
    else process.env.SUBQ_API_KEY = originalSubqKey;
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${testDbPath}${suffix}`))
        unlinkSync(`${testDbPath}${suffix}`);
    }
  });

  async function article(
    id: string,
    options: { title?: string; score?: number | null; ageDays?: number } = {},
  ) {
    const { getDb } = await import('$lib/server/db');
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO articles
      (id, feed_id, url, title, jev_score, heuristic_score, combined_score, fetched_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 50, 71, ?, ?, ?)`,
      )
      .run(
        id,
        'fresh-feed',
        `https://example.com/${id}`,
        options.title ?? 'Fresh compiler release',
        options.score === undefined ? 0.8 : options.score,
        now - (options.ageDays ?? 0) * 86400000,
        now,
        now,
      );
  }

  it.each(['thumbs_up', 'thumbs_down', 'boost'] as const)(
    'invalidates visible, unscored, and matching scores after %s',
    async (type) => {
      await article('feedback');
      await article('visible', { title: 'Unrelated obituary', ageDays: 100 });
      await article('matching');
      await article('unscored', { score: null });
      await article('old', { ageDays: 100 });
      const { recordInteraction } = await import('./interactions');
      const { getDb } = await import('$lib/server/db');
      recordInteraction('feedback', type, {
        visibleArticleIds: ['visible', 'visible', 'unknown'],
      });
      const db = getDb();
      const rows = db
        .prepare(
          'SELECT id, jev_score, heuristic_score, combined_score FROM articles',
        )
        .all() as Array<{
        id: string;
        jev_score: number | null;
        heuristic_score: number;
        combined_score: number | null;
      }>;
      for (const id of ['feedback', 'visible', 'matching', 'unscored']) {
        const row = rows.find((entry) => entry.id === id)!;
        expect(row.jev_score).toBeNull();
        expect(row.combined_score).toBeNull();
      }
      expect(rows.find((entry) => entry.id === 'old')!.jev_score).toBe(0.8);
      const queued = db
        .prepare('SELECT article_id FROM ranking_refresh_queue')
        .all() as Array<{ article_id: string }>;
      expect(new Set(queued.map((row) => row.article_id))).toEqual(
        new Set(['feedback', 'visible', 'matching', 'unscored']),
      );
      expect(
        rows.find((entry) => entry.id === 'matching')!.heuristic_score,
      ).not.toBe(50);
    },
  );

  it('bounds and deduplicates visibility context even for direct service callers', async () => {
    await article('feedback');
    const visible = Array.from(
      { length: 40 },
      (_, index) => `visible-${index}`,
    );
    for (const id of visible) await article(id, { ageDays: 100 });
    const { recordInteraction } = await import('./interactions');
    const { getDb } = await import('$lib/server/db');
    recordInteraction('feedback', 'thumbs_up', {
      visibleArticleIds: [visible[0], ...visible],
    });
    const rows = getDb()
      .prepare('SELECT article_id FROM ranking_refresh_queue')
      .all() as Array<{ article_id: string }>;
    expect(rows).toHaveLength(31);
    expect(rows.some((row) => row.article_id === 'visible-30')).toBe(false);
  });

  it('learns offline rejection once across idempotent replay', async () => {
    await article('offline');
    const { applyArticleState } = await import('./article-state');
    const { getDb } = await import('$lib/server/db');
    const input = {
      articleIds: ['offline'],
      action: 'reject' as const,
      idempotencyKey: 'offline-freshness',
    };
    const first = applyArticleState(input);
    const evidence = getDb()
      .prepare('SELECT SUM(evidence_count) AS n FROM user_preference_memory')
      .get() as { n: number };
    expect(evidence.n).toBeGreaterThan(0);
    const replay = applyArticleState(input);
    expect(first.idempotent).toBe(false);
    expect(replay.idempotent).toBe(true);
    expect(
      getDb()
        .prepare('SELECT SUM(evidence_count) AS n FROM user_preference_memory')
        .get(),
    ).toEqual(evidence);
    expect(
      getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM user_interactions WHERE interaction_type = 'thumbs_down'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it('retains requests when Jev capacity is full', async () => {
    await article('feedback');
    const { enqueueJevProcess, DEFAULT_JEV_QUEUE_CAPACITY } =
      await import('./feed/job-queue');
    for (let index = 0; index < DEFAULT_JEV_QUEUE_CAPACITY; index++) {
      await article(`busy-${index}`, { ageDays: 100 });
      enqueueJevProcess(`busy-${index}`);
    }
    const { recordInteraction } = await import('./interactions');
    const { flushRankingRefreshQueue } = await import('./ranking-freshness');
    const { getDb } = await import('$lib/server/db');
    recordInteraction('feedback', 'boost');
    await flushRankingRefreshQueue();
    expect(
      getDb()
        .prepare(
          'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
        )
        .get('feedback'),
    ).toBeTruthy();
    getDb().prepare('DELETE FROM jobs').run();
    await flushRankingRefreshQueue();
    expect(
      getDb()
        .prepare(
          'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
        )
        .get('feedback'),
    ).toBeUndefined();
    expect(
      getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM jobs WHERE json_extract(payload, '$.articleId') = 'feedback'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it('drains local refresh work when the ranking provider key is missing', async () => {
    await article('missing-key-refresh');
    process.env.JEV_API_KEY = '';
    process.env.TYPESAFE_API_KEY = '';
    const { getDb } = await import('$lib/server/db');
    const { markArticleForRankingRefresh, flushRankingRefreshQueue } =
      await import('./ranking-freshness');
    const { getNextQueuedJobAt } = await import('./feed/job-queue');
    const now = Date.now();

    markArticleForRankingRefresh('missing-key-refresh', 1, now);

    expect(getNextQueuedJobAt()).toBeLessThanOrEqual(Date.now());
    await flushRankingRefreshQueue(now + 1);
    expect(
      getDb()
        .prepare(
          'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
        )
        .get('missing-key-refresh'),
    ).toBeUndefined();
  });

  it('removes orphaned refresh rows before selecting due work', async () => {
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = Date.now();
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      'INSERT INTO ranking_refresh_queue (article_id, requested_revision, heuristic_revision, not_before, created_at) VALUES (?, ?, NULL, ?, ?)',
    ).run('deleted-article', 1, now, now);
    db.exec('PRAGMA foreign_keys = ON');

    const { flushRankingRefreshQueue } = await import('./ranking-freshness');
    await flushRankingRefreshQueue(now);

    expect(
      db
        .prepare(
          'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
        )
        .get('deleted-article'),
    ).toBeUndefined();
  });

  it('defers repeated scoring during the persisted cooldown without losing feedback', async () => {
    await article('cooldown');
    const { getDb } = await import('$lib/server/db');
    const { recordInteraction } = await import('./interactions');
    const { flushRankingRefreshQueue, RANKING_REFRESH_RATE_LIMIT_MS } =
      await import('./ranking-freshness');
    const { getNextQueuedJobAt } = await import('./feed/job-queue');
    const lastScoredAt = Date.now();
    getDb()
      .prepare('UPDATE articles SET ranking_refreshed_at = ? WHERE id = ?')
      .run(lastScoredAt, 'cooldown');
    recordInteraction('cooldown', 'thumbs_up');
    recordInteraction('cooldown', 'boost');
    await flushRankingRefreshQueue(lastScoredAt + 1);
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'jev_process'")
        .get(),
    ).toEqual({ n: 0 });
    const marker = getDb()
      .prepare(
        'SELECT requested_revision, not_before FROM ranking_refresh_queue WHERE article_id = ?',
      )
      .get('cooldown') as { requested_revision: number; not_before: number };
    expect(marker.requested_revision).toBe(2);
    expect(marker.not_before).toBe(
      lastScoredAt + RANKING_REFRESH_RATE_LIMIT_MS,
    );
    expect(getNextQueuedJobAt()).toBe(marker.not_before);
    await flushRankingRefreshQueue(marker.not_before);
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'jev_process'")
        .get(),
    ).toEqual({ n: 1 });
  });

  it('activates a fresh Jev result and persists its cooldown timestamp', async () => {
    await article('fresh-result', { score: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ answers: { would_open: { noul: 0.9 } } }), {
        status: 200,
      }),
    );
    const { scoreArticleWithJev } = await import('./ai/jev');
    const { getDb } = await import('$lib/server/db');
    const before = Date.now();
    expect(await scoreArticleWithJev('fresh-result')).toBe(0.9);
    const row = getDb()
      .prepare(
        'SELECT jev_score, combined_score, ranking_refreshed_at FROM articles WHERE id = ?',
      )
      .get('fresh-result') as {
      jev_score: number;
      combined_score: number;
      ranking_refreshed_at: number;
    };
    expect(row.jev_score).toBe(0.9);
    expect(row.combined_score).toBe(78);
    expect(row.ranking_refreshed_at).toBeGreaterThanOrEqual(before);
  });

  it('satisfies a pending refresh when another current-profile score completes', async () => {
    await article('already-fresh');
    const { recordInteraction } = await import('./interactions');
    const { scoreArticleWithJev } = await import('./ai/jev');
    const { flushRankingRefreshQueue } = await import('./ranking-freshness');
    const { getDb } = await import('$lib/server/db');
    recordInteraction('already-fresh', 'thumbs_up');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ answers: { would_open: { noul: 0.9 } } }), {
        status: 200,
      }),
    );
    await scoreArticleWithJev('already-fresh');
    expect(
      getDb()
        .prepare(
          'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
        )
        .get('already-fresh'),
    ).toBeUndefined();
    await flushRankingRefreshQueue();
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'jev_process'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it('skips a queued successor after the processing job stores a fresh score', async () => {
    await article('successor-fresh');
    const { enqueueJevProcess, runDueJobs } = await import('./feed/job-queue');
    const { recordInteraction } = await import('./interactions');
    const { flushRankingRefreshQueue } = await import('./ranking-freshness');
    const { scoreArticleWithJev } = await import('./ai/jev');
    const { getDb } = await import('$lib/server/db');
    const now = Date.now();
    const first = enqueueJevProcess('successor-fresh', { now })!;
    getDb()
      .prepare(
        "UPDATE jobs SET status = 'processing', started_at = ? WHERE id = ?",
      )
      .run(now, first.id);

    recordInteraction('successor-fresh', 'thumbs_up');
    await flushRankingRefreshQueue();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ answers: { would_open: { noul: 0.9 } } }), {
        status: 200,
      }),
    );
    await scoreArticleWithJev('successor-fresh');

    const fetchSpy = vi.mocked(globalThis.fetch);
    await runDueJobs({ now: Date.now() + 1, maxJobs: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const jobs = getDb()
      .prepare(
        "SELECT status, result FROM jobs WHERE type = 'jev_process' AND id != ?",
      )
      .all(first.id) as Array<{ status: string; result: string }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('completed');
    expect(JSON.parse(jobs[0].result)).toMatchObject({ skipped: true });
  });

  it('refreshes every directly changed article in bulk feedback', async () => {
    const ids = Array.from({ length: 65 }, (_, index) => `bulk-${index}`);
    for (const id of ids) await article(id);
    const { applyArticleState } = await import('./article-state');
    const { getDb } = await import('$lib/server/db');
    applyArticleState({
      articleIds: ids,
      action: 'reject',
      idempotencyKey: 'bulk-freshness',
    });
    const rows = getDb()
      .prepare(
        'SELECT jev_score, heuristic_score, combined_score FROM articles',
      )
      .all() as Array<{
      jev_score: number | null;
      heuristic_score: number;
      combined_score: number | null;
    }>;
    expect(rows).toHaveLength(65);
    for (const row of rows) {
      expect(row.jev_score).toBeNull();
      expect(row.combined_score).toBeNull();
      expect(row.heuristic_score).toBeLessThan(50);
    }
  });

  it('skips queued feedback scoring that a current-profile result already satisfied', async () => {
    await article('satisfied-job', { score: null });
    const { enqueueJevProcess, runDueJobs } = await import('./feed/job-queue');
    const { scoreArticleWithJev } = await import('./ai/jev');
    enqueueJevProcess('satisfied-job', { feedback: true });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ answers: { would_open: { noul: 0.9 } } }),
          { status: 200 },
        ),
      );
    await scoreArticleWithJev('satisfied-job');
    const result = await runDueJobs({ maxJobs: 1 });
    expect(result.completed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['read', 'open', 'save', 'hide'] as const)(
    'guards an in-flight profile snapshot after %s',
    async (type) => {
      await article('implicit-race');
      let resolveFetch!: (response: Response) => void;
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      );
      const { scoreArticleWithJev } = await import('./ai/jev');
      const { recordInteraction } = await import('./interactions');
      const { getDb } = await import('$lib/server/db');
      const pending = scoreArticleWithJev('implicit-race');
      await vi.waitFor(() => expect(resolveFetch).toBeTypeOf('function'));
      recordInteraction('implicit-race', type);
      resolveFetch(
        new Response(
          JSON.stringify({ answers: { would_open: { noul: 0.99 } } }),
          { status: 200 },
        ),
      );
      expect(await pending).toBeNull();
      expect(
        getDb()
          .prepare('SELECT jev_score FROM articles WHERE id = ?')
          .get('implicit-race'),
      ).toEqual({ jev_score: null });
      expect(
        getDb()
          .prepare(
            'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
          )
          .get('implicit-race'),
      ).toBeTruthy();
    },
  );

  it('defers ordinary queued Jev work behind a feedback cooldown', async () => {
    await article('ordinary-cooldown');
    const { getDb } = await import('$lib/server/db');
    const { enqueueJevProcess, runDueJobs } = await import('./feed/job-queue');
    const { recordInteraction } = await import('./interactions');
    const now = Date.now();
    getDb()
      .prepare('UPDATE articles SET ranking_refreshed_at = ? WHERE id = ?')
      .run(now, 'ordinary-cooldown');
    enqueueJevProcess('ordinary-cooldown');
    recordInteraction('ordinary-cooldown', 'thumbs_up');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const result = await runDueJobs({ maxJobs: 1 });
    expect(result.processed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      getDb()
        .prepare(
          "SELECT status FROM jobs WHERE json_extract(payload, '$.articleId') = ?",
        )
        .get('ordinary-cooldown'),
    ).toEqual({ status: 'queued' });
  });

  it('coalesces feedback during processing into one successor', async () => {
    await article('processing');
    const { enqueueJevProcess } = await import('./feed/job-queue');
    const { getDb } = await import('$lib/server/db');
    const first = enqueueJevProcess('processing')!;
    getDb()
      .prepare(
        "UPDATE jobs SET status = 'processing', started_at = ? WHERE id = ?",
      )
      .run(Date.now(), first.id);
    const successor = enqueueJevProcess('processing', { feedback: true });
    const repeated = enqueueJevProcess('processing', { feedback: true });
    expect(successor!.id).not.toBe(first.id);
    expect(repeated!.id).toBe(successor!.id);
    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE type = 'jev_process'")
        .get(),
    ).toEqual({ n: 2 });
  });

  it.each([false, true])(
    'rejects an in-flight stale Jev response (error=%s)',
    async (fail) => {
      await article('racing');
      let resolveFetch!: (value: Response) => void;
      let rejectFetch!: (error: Error) => void;
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        () =>
          new Promise<Response>((resolve, reject) => {
            resolveFetch = resolve;
            rejectFetch = reject;
          }),
      );
      const { scoreArticleWithJev } = await import('./ai/jev');
      const { recordInteraction } = await import('./interactions');
      const { getDb } = await import('$lib/server/db');
      const pending = scoreArticleWithJev('racing');
      await vi.waitFor(() => expect(resolveFetch).toBeTypeOf('function'));
      recordInteraction('racing', 'thumbs_up');
      if (fail) rejectFetch(new Error('old request failed'));
      else
        resolveFetch(
          new Response(
            JSON.stringify({ answers: { would_open: { noul: 0.99 } } }),
            { status: 200 },
          ),
        );
      await pending.catch(() => null);
      const row = getDb()
        .prepare('SELECT jev_score, jev_error FROM articles WHERE id = ?')
        .get('racing');
      expect(row).toEqual({ jev_score: null, jev_error: '' });
      expect(
        getDb()
          .prepare(
            'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
          )
          .get('racing'),
      ).toBeTruthy();
    },
  );

  it('reconciles null heuristic_revision at revision 0 and skips hidden feedback targets', async () => {
    await article('rev-zero');
    await article('hidden-unscored', { score: null });
    const { getDb } = await import('$lib/server/db');
    const { flushRankingRefreshQueue, refreshRankingAfterFeedback } =
      await import('./ranking-freshness');
    const db = getDb();
    const now = Date.now();

    db.prepare('UPDATE articles SET hidden = 1 WHERE id = ?').run(
      'hidden-unscored',
    );
    db.prepare(
      `INSERT INTO ranking_refresh_queue (article_id, requested_revision, heuristic_revision, not_before, created_at)
       VALUES ('rev-zero', 0, NULL, ?, ?)`,
    ).run(now - 1000, now - 1000);

    const queued = await flushRankingRefreshQueue(now, 4);
    expect(queued).toBe(1);
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM ranking_refresh_queue').get() as {
        c: number;
      },
    ).toEqual({ c: 0 });

    const feedbackResult = refreshRankingAfterFeedback({
      articleIds: ['rev-zero'],
      type: 'thumbs_up',
    });
    expect(feedbackResult.refreshedArticleIds).not.toContain('hidden-unscored');
  });

  it('routes save and hide through cohort invalidation and forwards visibleArticleIds from state POST', async () => {
    await article('cohort-source');
    await article('cohort-sibling');
    await article('cohort-visible', {
      title: 'Unrelated obituary',
      ageDays: 100,
    });
    const { getDb } = await import('$lib/server/db');
    const { POST } = await import('../../routes/api/articles/state/+server');
    const { getRankingFeedbackRevision } = await import('./ranking-freshness');

    const beforeRev = getRankingFeedbackRevision();
    const res = await POST({
      request: new Request('http://localhost/api/articles/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          articleId: 'cohort-source',
          visibleArticleIds: ['cohort-visible'],
          idempotencyKey: 'save-cohort-1',
        }),
      }),
      locals: { sessionId: 'test-sess' },
    } as never);
    expect(res.status).toBe(200);
    expect(getRankingFeedbackRevision()).toBe(beforeRev + 1);
    const db = getDb();
    expect(
      db
        .prepare('SELECT jev_score FROM articles WHERE id = ?')
        .get('cohort-sibling'),
    ).toEqual({ jev_score: null });
    expect(
      db
        .prepare('SELECT jev_score FROM articles WHERE id = ?')
        .get('cohort-visible'),
    ).toEqual({ jev_score: null });

    const { applyArticleState } = await import('./article-state');
    db.prepare('UPDATE articles SET jev_score = 0.8 WHERE id = ?').run(
      'cohort-sibling',
    );
    applyArticleState({
      articleIds: ['cohort-source'],
      action: 'hide',
      idempotencyKey: 'hide-cohort-1',
    });
    expect(
      db
        .prepare('SELECT jev_score FROM articles WHERE id = ?')
        .get('cohort-sibling'),
    ).toEqual({ jev_score: null });
  });

  it('excludes paused feeds from feedback refresh targets, queue flushing, and preserves older saved heuristics on global mutation', async () => {
    await article('enabled-art');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, title, enabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    ).run('paused-feed', 'https://paused.example.com/rss', 'Paused', now, now);
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, categories, jev_score, heuristic_score, saved, fetched_at, created_at, updated_at)
       VALUES ('paused-art', 'paused-feed', 'https://paused.example.com/1', 'Science story', '["Science"]', 0.8, 50, 0, ?, ?, ?)`,
    ).run(now, now, now);
    const enabledFeedId = (
      db
        .prepare('SELECT feed_id FROM articles WHERE id = ?')
        .get('enabled-art') as { feed_id: string }
    ).feed_id;
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, categories, jev_score, heuristic_score, saved, fetched_at, created_at, updated_at)
       VALUES ('old-saved-art', ?, 'https://example.com/old-saved', 'Science bookmark', '["Science"]', 0.8, 50, 1, ?, ?, ?)`,
    ).run(enabledFeedId, now - 90 * 24 * 60 * 60 * 1000, now, now);
    db.prepare(
      'INSERT INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'pref-sci',
      'topic:science',
      'topic',
      'positive',
      0.9,
      5,
      now,
      '',
      now,
    );

    const {
      refreshRankingAfterFeedback,
      flushRankingRefreshQueue,
      refreshRankingAfterGlobalProfileMutation,
    } = await import('./ranking-freshness');

    const fb = refreshRankingAfterFeedback({
      articleIds: ['enabled-art'],
      type: 'thumbs_up',
      visibleArticleIds: ['paused-art'],
    });
    expect(
      db
        .prepare(
          'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
        )
        .get('paused-art'),
    ).toBeUndefined();
    expect(
      db
        .prepare('SELECT jev_score FROM articles WHERE id = ?')
        .get('paused-art'),
    ).toEqual({ jev_score: 0.8 });

    // Even if a paused row were in ranking_refresh_queue, flush deletes it without queueing Jev
    db.prepare(
      'INSERT INTO ranking_refresh_queue (article_id, requested_revision, heuristic_revision, not_before, created_at) VALUES (?, 1, 1, ?, ?)',
    ).run('paused-art', now - 1000, now - 1000);
    await flushRankingRefreshQueue(now);
    expect(
      db
        .prepare(
          'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
        )
        .get('paused-art'),
    ).toBeUndefined();
    expect(fb.revision).toBeGreaterThan(0);

    // Global profile mutation excludes paused feeds from refresh queue and retains older bookmark heuristic adjustments
    refreshRankingAfterGlobalProfileMutation();
    expect(
      db
        .prepare(
          'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
        )
        .get('paused-art'),
    ).toBeUndefined();
    const savedRow = db
      .prepare('SELECT heuristic_score FROM articles WHERE id = ?')
      .get('old-saved-art') as { heuristic_score: number };
    expect(savedRow.heuristic_score).toBeGreaterThan(60);
  });
});
