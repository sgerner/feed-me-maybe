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

vi.mock('#lib/server/feed/fetcher.ts', () => ({
  fetchFeed: vi.fn(),
}));
vi.mock('#lib/server/sources/reddit.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('#lib/server/sources/reddit.ts')>();
  return {
    ...actual,
    fetchRedditSource: vi.fn(),
  };
});
vi.mock('#lib/server/proxy.ts', () => ({
  getConfiguredProxyBaseUrl: () => 'https://proxy.example.workers.dev',
}));
vi.mock('#lib/server/poller.ts', () => ({
  wakePoller: vi.fn(),
}));

import { GET, POST } from './+server';

describe('POST /api/feeds discovery timeout budgets', () => {
  let testDb: TestDbHandle;

  beforeAll(() => {
    testDb = createTestDb('feed-me-maybe-feeds-api-');
  });

  beforeEach(async () => {
    testDb.reset();
    const { fetchFeed } = await import('#lib/server/feed/fetcher.ts');
    const { fetchRedditSource } = await import('#lib/server/sources/reddit.ts');
    vi.mocked(fetchFeed).mockReset();
    vi.mocked(fetchRedditSource).mockReset();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  it('gives proxy discovery an independent non-aborted timeout after direct discovery times out', async () => {
    const { fetchFeed } = await import('#lib/server/feed/fetcher.ts');
    vi.mocked(fetchFeed)
      .mockImplementationOnce(async (_url, opts) => {
        expect(opts?.deadline?.aborted).toBe(false);
        // Simulate direct timeout exhausting the direct deadline signal.
        return { success: false, items: [], error: 'The operation timed out' };
      })
      .mockImplementationOnce(async (url, opts) => {
        expect(opts?.proxyBaseUrl).toBe('https://proxy.example.workers.dev');
        expect(opts?.deadline?.aborted).toBe(false);
        return {
          success: true,
          subscriptionUrl: url,
          title: 'Proxied Feed',
          items: [],
        };
      });

    const response = await POST({
      locals: { sessionId: 'sess-1' },
      request: new Request('http://localhost/api/feeds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/feed/?rss' }),
      }),
    } as Parameters<typeof POST>[0]);

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      feed: { url: string; use_proxy: number; title: string };
    };
    expect(body.feed.url).toBe('https://example.com/feed/?rss');
    expect(body.feed.use_proxy).toBe(1);
    expect(body.feed.title).toBe('Proxied Feed');
    expect(fetchFeed).toHaveBeenCalledTimes(2);
  });

  it('gives Reddit proxy discovery an independent non-aborted timeout after direct Reddit validation fails', async () => {
    const { fetchRedditSource } = await import('#lib/server/sources/reddit.ts');
    vi.mocked(fetchRedditSource)
      .mockImplementationOnce(async (_source, opts) => {
        expect(opts?.deadline?.aborted).toBe(false);
        return { success: false, items: [], error: 'Timed out' };
      })
      .mockImplementationOnce(async (_source, opts) => {
        expect(opts?.proxyBaseUrl).toBe('https://proxy.example.workers.dev');
        expect(opts?.deadline?.aborted).toBe(false);
        return {
          success: true,
          items: [],
          title: 'r/codex',
        };
      });

    const response = await POST({
      locals: { sessionId: 'sess-1' },
      request: new Request('http://localhost/api/feeds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://sh.reddit.com/r/codex/best' }),
      }),
    } as Parameters<typeof POST>[0]);

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      feed: { source_type: string; use_proxy: number };
    };
    expect(body.feed.source_type).toBe('reddit');
    expect(body.feed.use_proxy).toBe(1);
    expect(fetchRedditSource).toHaveBeenCalledTimes(2);
  });

  it('persists validated items, ETag, and Last-Modified on POST /api/feeds without queueing a duplicate fetch job and reports grouped counts in GET /api/feeds', async () => {
    const { fetchFeed } = await import('#lib/server/feed/fetcher.ts');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();

    vi.mocked(fetchFeed).mockResolvedValueOnce({
      success: true,
      subscriptionUrl: 'https://example.com/initial.xml',
      title: 'Initial Feed',
      description: 'Initial Desc',
      link: 'https://example.com',
      imageUrl: 'https://example.com/icon.png',
      etag: '"initial-etag"',
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
      items: [
        {
          guid: 'init-1',
          url: 'https://example.com/posts/1',
          title: 'First Initial Post',
          summary: 'Summary 1',
          content: '<p>Body 1</p>',
          categories: ['news'],
        },
        {
          guid: 'init-2',
          url: 'https://example.com/posts/2',
          title: 'Second Initial Post',
          summary: 'Summary 2',
          content: '<p>Body 2</p>',
          categories: ['tech'],
        },
      ],
    });

    const createRes = await POST({
      locals: { sessionId: 'sess-1' },
      request: new Request('http://localhost/api/feeds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/initial.xml' }),
      }),
    } as Parameters<typeof POST>[0]);
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      feed: {
        id: string;
        etag: string;
        last_modified_header: string;
        last_fetch_status: string;
      };
    };
    expect(created.feed.etag).toBe('"initial-etag"');
    expect(created.feed.last_modified_header).toBe(
      'Wed, 21 Oct 2026 07:28:00 GMT',
    );
    expect(created.feed.last_fetch_status).toBe('success');

    // Initial articles ingested directly without queueing a duplicate feed_fetch job
    expect(
      db
        .prepare('SELECT COUNT(*) FROM articles WHERE feed_id = ?')
        .pluck()
        .get(created.feed.id),
    ).toBe(2);
    expect(
      db
        .prepare("SELECT COUNT(*) FROM jobs WHERE type = 'feed_fetch'")
        .pluck()
        .get(),
    ).toBe(0);

    // Mark one article saved and one article rejected, plus add a paused feed with unread item
    db.prepare(
      "UPDATE articles SET saved = 1 WHERE feed_id = ? AND guid = 'init-1'",
    ).run(created.feed.id);
    db.prepare(
      "UPDATE articles SET rejected = 1 WHERE feed_id = ? AND guid = 'init-2'",
    ).run(created.feed.id);
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, title, enabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    ).run('paused-f', 'https://paused.example/rss', 'Paused Feed', now, now);
    db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, read, hidden, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)',
    ).run(
      'paused-art',
      'paused-f',
      'https://paused.example/1',
      'Paused Unread',
      now,
      now,
      now,
    );

    const listRes = await GET({
      locals: { sessionId: 'sess-1' },
    } as Parameters<typeof GET>[0]);
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      feeds: Array<{
        id: string;
        unread_count: number;
        saved_count: number;
        health: { status: string };
      }>;
      totalUnread: number;
    };
    const activeFeed = listed.feeds.find((f) => f.id === created.feed.id)!;
    expect(activeFeed.unread_count).toBe(1); // Rejected article excluded from unread_count
    expect(activeFeed.saved_count).toBe(1);
    expect(activeFeed.health.status).toBe('healthy');
    expect(listed.totalUnread).toBe(1); // Paused feed excluded from totalUnread
  });
});
