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

import { POST } from './+server';

describe('POST /api/feeds discovery timeout budgets', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-feeds-api.db');
  const originalDbUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbPath;
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const { initializeDatabase } = await import('#lib/server/db/migrate.ts');
    initializeDatabase();
  });

  beforeEach(async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    db.prepare('DELETE FROM jobs').run();
    db.prepare('DELETE FROM feeds').run();
    const { fetchFeed } = await import('#lib/server/feed/fetcher.ts');
    const { fetchRedditSource } = await import('#lib/server/sources/reddit.ts');
    vi.mocked(fetchFeed).mockReset();
    vi.mocked(fetchRedditSource).mockReset();
  });

  afterAll(async () => {
    const { closeDb } = await import('#lib/server/db/index.ts');
    closeDb();
    process.env.DATABASE_URL = originalDbUrl ?? '';
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${testDbPath}${suffix}`))
        unlinkSync(`${testDbPath}${suffix}`);
    }
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
});
