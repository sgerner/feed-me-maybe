import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createTestDb, type TestDbHandle } from '#lib/server/db/test-db.ts';

const pollerMocks = vi.hoisted(() => ({
  wakePoller: vi.fn(),
  scheduleNextPoll: vi.fn(),
}));
const fetcherMocks = vi.hoisted(() => ({
  fetchFeed: vi.fn(),
}));
const redditMocks = vi.hoisted(() => ({
  fetchRedditSource: vi.fn(),
  isRedditUrl: vi.fn(() => false),
  normalizeRedditUrl: vi.fn((url: string) => ({
    originalUrl: url,
    normalizedUrl: url,
    redditKind: 'subreddit',
    fetchUrl: `${url}.rss`,
    subreddit: 'rust',
  })),
}));
const proxyMocks = vi.hoisted(() => ({
  getConfiguredProxyBaseUrl: vi.fn<() => string | undefined>(() => undefined),
}));

vi.mock('#lib/server/poller.ts', () => pollerMocks);
vi.mock('#lib/server/feed/fetcher.ts', () => fetcherMocks);
vi.mock('#lib/server/sources/reddit.ts', () => redditMocks);
vi.mock('#lib/server/proxy.ts', () => proxyMocks);

describe('feed settings, refresh, and batch APIs', () => {
  let testDb: TestDbHandle;

  beforeAll(() => {
    testDb = createTestDb('feed-me-maybe-feeds-ops-api-');
  });

  beforeEach(() => {
    testDb.reset();
    pollerMocks.wakePoller.mockReset();
    pollerMocks.scheduleNextPoll.mockReset();
    fetcherMocks.fetchFeed.mockReset();
    redditMocks.fetchRedditSource.mockReset();
    redditMocks.isRedditUrl.mockReset().mockReturnValue(false);
    proxyMocks.getConfiguredProxyBaseUrl.mockReset().mockReturnValue(undefined);
  });

  afterAll(() => {
    testDb.cleanup();
  });

  function requestEvent(
    method: string,
    body?: unknown,
    { sessionId = 'session-1', id = 'feed-1' } = {},
  ) {
    return {
      request: new Request('http://localhost/api/feeds', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body:
          body === undefined
            ? undefined
            : typeof body === 'string'
              ? body
              : JSON.stringify(body),
      }),
      locals: { sessionId: sessionId || undefined },
      params: { id },
      url: new URL('http://localhost/api/feeds'),
    } as never;
  }

  it('preserves title and article_search.feed_title when title is cleared and validates poll_interval_mins', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { PATCH } = await import('./[id]/+server');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, title, custom_title, category, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    ).run(
      'feed-title',
      'https://example.com/rss',
      'Original Feed',
      'Tech',
      now,
      now,
    );
    db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'art-title',
      'feed-title',
      'https://example.com/1',
      'Hello',
      now,
      now,
      now,
    );

    // Invalid JSON body -> 400
    const badJson = await PATCH(
      requestEvent('PATCH', 'null', { id: 'feed-title' }),
    );
    expect(badJson.status).toBe(400);

    // Invalid poll_interval_mins -> 400
    const badPoll = await PATCH(
      requestEvent('PATCH', { poll_interval_mins: 0 }, { id: 'feed-title' }),
    );
    expect(badPoll.status).toBe(400);

    // Clear title -> custom_title becomes 0, title and FTS feed_title preserved
    const cleared = await PATCH(
      requestEvent(
        'PATCH',
        { title: '', poll_interval_mins: 10 },
        { id: 'feed-title' },
      ),
    );
    expect(cleared.status).toBe(200);
    const payload = await cleared.json();
    expect(payload.feed).toMatchObject({
      title: 'Original Feed',
      custom_title: 0,
      poll_interval_mins: 10,
    });
    expect(pollerMocks.scheduleNextPoll).toHaveBeenCalledTimes(1);

    const searchRow = db
      .prepare('SELECT feed_title FROM article_search WHERE article_id = ?')
      .get('art-title') as { feed_title: string };
    expect(searchRow.feed_title).toBe('Original Feed');

    // Sending unchanged title when custom_title = 0 does not lock custom_title = 1
    const unchanged = await PATCH(
      requestEvent('PATCH', { title: 'Original Feed' }, { id: 'feed-title' }),
    );
    expect(unchanged.status).toBe(200);
    expect((await unchanged.json()).feed.custom_title).toBe(0);

    // Distinct non-empty title sets custom_title = 1
    const renamed = await PATCH(
      requestEvent('PATCH', { title: 'Custom Name' }, { id: 'feed-title' }),
    );
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).feed).toMatchObject({
      title: 'Custom Name',
      custom_title: 1,
    });
  });

  it('updates metadata with proxy fallback on URL edit and queues successor when processing', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { PATCH } = await import('./[id]/+server');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, title, custom_title, description, site_url, icon_url, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)',
    ).run(
      'feed-url',
      'https://old.example/rss',
      'Old Title',
      'Old Desc',
      'https://old.example',
      'https://old.example/icon.png',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, started_at, created_at)
       VALUES ('inflight-url', 'feed_fetch', 'processing', ?, 1, 4, ?, ?)`,
    ).run(JSON.stringify({ feedId: 'feed-url' }), now, now);

    proxyMocks.getConfiguredProxyBaseUrl.mockReturnValue('https://proxy.test');
    fetcherMocks.fetchFeed
      .mockResolvedValueOnce({ success: false, items: [], error: 'Blocked' })
      .mockResolvedValueOnce({
        success: true,
        subscriptionUrl: 'https://new.example/feed.xml',
        title: 'New Title',
        description: 'New Desc',
        link: 'https://new.example',
        imageUrl: 'https://new.example/favicon.ico',
        items: [],
      });

    const res = await PATCH(
      requestEvent('PATCH', { url: 'https://new.example' }, { id: 'feed-url' }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.feed).toMatchObject({
      url: 'https://new.example/feed.xml',
      title: 'New Title',
      description: 'New Desc',
      site_url: 'https://new.example',
      icon_url: 'https://new.example/favicon.ico',
      use_proxy: 1,
    });
    expect(pollerMocks.wakePoller).toHaveBeenCalledTimes(1);

    const queuedJobs = db
      .prepare(
        "SELECT id, status FROM jobs WHERE type = 'feed_fetch' AND json_extract(payload, '$.feedId') = 'feed-url' AND status = 'queued'",
      )
      .all();
    expect(queuedJobs).toHaveLength(1);
  });

  it('validates Reddit URL edits with fetchRedditSource', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { PATCH } = await import('./[id]/+server');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      "INSERT INTO feeds (id, url, title, source_type, created_at, updated_at) VALUES (?, ?, ?, 'reddit', ?, ?)",
    ).run('feed-reddit', 'https://www.reddit.com/r/old', 'Old Sub', now, now);

    redditMocks.isRedditUrl.mockReturnValue(true);
    redditMocks.fetchRedditSource.mockResolvedValue({
      success: false,
      items: [],
      error: 'Subreddit not found',
    });

    const invalid = await PATCH(
      requestEvent(
        'PATCH',
        { url: 'https://www.reddit.com/r/missing' },
        { id: 'feed-reddit' },
      ),
    );
    expect(invalid.status).toBe(422);
    expect(redditMocks.fetchRedditSource).toHaveBeenCalledTimes(1);
  });

  it('resets errors and queues fetch when use_proxy changes or enabled transitions 0 -> 1', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { PATCH } = await import('./[id]/+server');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      "INSERT INTO feeds (id, url, enabled, use_proxy, error_count, last_error, last_fetch_status, created_at, updated_at) VALUES (?, ?, 0, 0, 5, 'Timeout', 'error', ?, ?)",
    ).run('feed-recover-edit', 'https://recover.example/rss', now, now);

    const res = await PATCH(
      requestEvent(
        'PATCH',
        { enabled: true, use_proxy: true },
        { id: 'feed-recover-edit' },
      ),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.feed).toMatchObject({
      enabled: 1,
      use_proxy: 1,
      error_count: 0,
      last_error: null,
    });
    expect(pollerMocks.wakePoller).toHaveBeenCalledTimes(1);
    const queued = db
      .prepare(
        "SELECT id FROM jobs WHERE type = 'feed_fetch' AND status = 'queued' AND json_extract(payload, '$.feedId') = 'feed-recover-edit'",
      )
      .all();
    expect(queued).toHaveLength(1);
  });

  it('cleans up orphaned jobs on DELETE /api/feeds/[id]', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { DELETE } = await import('./[id]/+server');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-del', 'https://del.example/rss', now, now);
    db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('art-del', 'feed-del', 'https://del.example/1', 'Del', now, now, now);
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, created_at)
       VALUES ('job-del-feed', 'feed_fetch', 'queued', ?, 0, 4, ?),
              ('job-del-art', 'ai_process', 'queued', ?, 0, 3, ?)`,
    ).run(
      JSON.stringify({ feedId: 'feed-del' }),
      now,
      JSON.stringify({ articleId: 'art-del' }),
      now,
    );

    const res = await DELETE(
      requestEvent('DELETE', undefined, { id: 'feed-del' }),
    );
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS c FROM jobs').get()).toEqual({
      c: 0,
    });
  });

  it('supports atomic bulk actions and cleans up orphaned jobs via POST /api/feeds/batch', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { POST } = await import('./batch/+server');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, enabled, category, error_count, last_error, created_at, updated_at) VALUES (?, ?, 0, ?, 3, ?, ?, ?)',
    ).run('b1', 'https://b1.example/rss', 'Old', 'Err', now, now);
    db.prepare(
      'INSERT INTO feeds (id, url, enabled, category, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)',
    ).run('b2', 'https://b2.example/rss', 'Old', now, now);
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, created_at)
       VALUES ('batch-job-b2', 'feed_fetch', 'queued', ?, 0, 4, ?)`,
    ).run(JSON.stringify({ feedId: 'b2' }), now);

    expect(
      (await POST(requestEvent('POST', {}, { sessionId: '' }))).status,
    ).toBe(401);
    expect((await POST(requestEvent('POST', 'null'))).status).toBe(400);
    expect(
      (await POST(requestEvent('POST', { feedIds: [], action: 'enable' })))
        .status,
    ).toBe(400);

    // Enable b1
    const enableRes = await POST(
      requestEvent('POST', { feedIds: ['b1'], action: 'enable' }),
    );
    expect(enableRes.status).toBe(200);
    expect(await enableRes.json()).toMatchObject({
      success: true,
      action: 'enable',
      updated: 1,
    });
    expect(
      db
        .prepare('SELECT enabled, error_count FROM feeds WHERE id = ?')
        .get('b1'),
    ).toEqual({ enabled: 1, error_count: 0 });
    expect(pollerMocks.wakePoller).toHaveBeenCalledTimes(1);

    // Set category on b1 and b2
    const catRes = await POST(
      requestEvent('POST', {
        feedIds: ['b1', 'b2'],
        action: 'set_category',
        category: 'Engineering',
      }),
    );
    expect(catRes.status).toBe(200);
    expect(
      db.prepare('SELECT category FROM feeds WHERE id = ?').get('b1'),
    ).toEqual({ category: 'Engineering' });

    // Disable b1
    const pauseRes = await POST(
      requestEvent('POST', { feedIds: ['b1'], action: 'disable' }),
    );
    expect(pauseRes.status).toBe(200);
    expect(
      db.prepare('SELECT enabled FROM feeds WHERE id = ?').get('b1'),
    ).toEqual({ enabled: 0 });

    // Delete b2 and clean up orphaned job
    const delRes = await POST(
      requestEvent('POST', { feedIds: ['b2'], action: 'delete' }),
    );
    expect(delRes.status).toBe(200);
    expect(
      db.prepare("SELECT id FROM jobs WHERE id = 'batch-job-b2'").get(),
    ).toBeUndefined();
    expect(
      db.prepare('SELECT id FROM feeds WHERE id = ?').get('b2'),
    ).toBeUndefined();
  });

  it('queues a refresh successor on POST /api/feeds/[id]/refresh and wakes poller on force=false', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { POST: refreshOne } = await import('./[id]/refresh/+server');
    const { POST: refreshAllFeeds } = await import('./refresh/+server');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
    ).run('feed-ref', 'https://ref.example/rss', now, now);
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, started_at, created_at)
       VALUES ('ref-inflight', 'feed_fetch', 'processing', ?, 1, 4, ?, ?)`,
    ).run(JSON.stringify({ feedId: 'feed-ref' }), now, now);

    const wakeRes = await refreshOne(
      requestEvent('POST', { force: false }, { id: 'feed-ref' }),
    );
    expect(wakeRes.status).toBe(202);
    expect(pollerMocks.wakePoller).toHaveBeenCalledTimes(1);

    const forceRes = await refreshOne(
      requestEvent('POST', { force: true }, { id: 'feed-ref' }),
    );
    expect(forceRes.status).toBe(202);
    const body = await forceRes.json();
    expect(body.queued).toBe(true);
    expect(body.job.id).not.toBe('ref-inflight');
    expect(body.job.status).toBe('queued');

    const allWake = await refreshAllFeeds(
      requestEvent('POST', { force: false }),
    );
    expect(allWake.status).toBe(200);
    expect(pollerMocks.wakePoller).toHaveBeenCalledTimes(2);
  });

  it('cancels queued ai_process, jev_process, and ranking_refresh_queue work when disabling feeds via PATCH or batch disable', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { PATCH } = await import('./[id]/+server');
    const { POST: batchPost } = await import('./batch/+server');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, enabled, created_at, updated_at) VALUES (?, ?, 1, ?, ?), (?, ?, 1, ?, ?)',
    ).run(
      'disable-one',
      'https://d1.example/rss',
      now,
      now,
      'disable-two',
      'https://d2.example/rss',
      now,
      now,
    );
    db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'art-d1',
      'disable-one',
      'https://d1.example/1',
      'D1',
      now,
      now,
      now,
      'art-d2',
      'disable-two',
      'https://d2.example/1',
      'D2',
      now,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO jobs (id, type, status, payload, attempts, max_attempts, created_at)
       VALUES ('ai-d1', 'ai_process', 'queued', ?, 0, 3, ?),
              ('jev-d1', 'jev_process', 'queued', ?, 0, 4, ?),
              ('ai-d2', 'ai_process', 'queued', ?, 0, 3, ?),
              ('jev-d2', 'jev_process', 'queued', ?, 0, 4, ?)`,
    ).run(
      JSON.stringify({ articleId: 'art-d1', feedId: 'disable-one' }),
      now,
      JSON.stringify({ articleId: 'art-d1' }),
      now,
      JSON.stringify({ articleId: 'art-d2', feedId: 'disable-two' }),
      now,
      JSON.stringify({ articleId: 'art-d2' }),
      now,
    );
    db.prepare(
      `INSERT INTO ranking_refresh_queue (article_id, requested_revision, heuristic_revision, not_before, created_at)
       VALUES ('art-d1', 1, 1, ?, ?), ('art-d2', 1, 1, ?, ?)`,
    ).run(now, now, now, now);

    const patchRes = await PATCH(
      requestEvent('PATCH', { enabled: false }, { id: 'disable-one' }),
    );
    expect(patchRes.status).toBe(200);
    expect(
      db.prepare("SELECT id FROM jobs WHERE id IN ('ai-d1', 'jev-d1')").all(),
    ).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT article_id FROM ranking_refresh_queue WHERE article_id = 'art-d1'",
        )
        .all(),
    ).toEqual([]);

    const batchRes = await batchPost(
      requestEvent('POST', { feedIds: ['disable-two'], action: 'disable' }),
    );
    expect(batchRes.status).toBe(200);
    expect(
      db.prepare("SELECT id FROM jobs WHERE id IN ('ai-d2', 'jev-d2')").all(),
    ).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT article_id FROM ranking_refresh_queue WHERE article_id = 'art-d2'",
        )
        .all(),
    ).toEqual([]);
  });
});
