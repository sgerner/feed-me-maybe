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

vi.mock('./fetcher', () => ({
  fetchFeed: vi.fn(),
}));
vi.mock('$lib/server/preferences', () => ({
  applyPreferenceModelToArticle: vi.fn(),
}));
vi.mock('$lib/server/webhooks', () => ({
  dispatchWebhookEvent: vi.fn(),
}));
vi.mock('$lib/server/realtime', () => ({
  broadcast: vi.fn(),
}));
vi.mock('$lib/server/proxy', () => ({
  getConfiguredProxyBaseUrl: () => undefined,
}));

describe('feed ingester identity and duplicate handling', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-feed-ingester.db');
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
    db.prepare('DELETE FROM articles').run();
    db.prepare('DELETE FROM feeds').run();
    const { fetchFeed } = await import('./fetcher');
    vi.mocked(fetchFeed).mockReset();
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

  it('normalizes tracking parameters, fragments, hosts, and query order', async () => {
    const { normalizeArticleUrl, generateArticleId } =
      await import('./ingester');
    const first = normalizeArticleUrl(
      'HTTPS://EXAMPLE.COM:443/story/?utm_source=feed&b=2&a=1#comments',
    );
    const second = normalizeArticleUrl('https://example.com/story?a=1&b=2');

    expect(first).toBe(second);
    expect(generateArticleId('feed-a', first, 'Title', 'guid-a')).toBe(
      generateArticleId('feed-a', second, 'Different title', 'guid-a'),
    );
    expect(generateArticleId('feed-a', first, 'Title', 'guid-a')).not.toBe(
      generateArticleId('feed-b', first, 'Title', 'guid-a'),
    );
  });

  it('deduplicates canonical URLs within a fetch and preserves article state', async () => {
    const { fetchFeed } = await import('./fetcher');
    const { ingestFeed } = await import('./ingester');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-ingest', 'https://example.com/rss', 'rss', now, now);

    const baseItem = {
      guid: 'guid-1',
      url: 'HTTPS://EXAMPLE.COM:443/story/?utm_campaign=test&b=2&a=1#top',
      title: 'Story',
      summary: 'Short summary',
      content: '<p>Short content</p>',
      categories: ['news'],
      publishedAt: new Date(now - 1_000),
    };
    vi.mocked(fetchFeed).mockResolvedValue({
      success: true,
      title: 'Example',
      items: [
        baseItem,
        {
          ...baseItem,
          guid: 'guid-2',
          url: 'https://example.com/story?a=1&b=2',
          content: '<p>Duplicate content with a different provider GUID.</p>',
        },
      ],
    });

    const first = await ingestFeed({ feedId: 'feed-ingest' });
    expect(first.success).toBe(true);
    expect(first.articlesFound).toBe(2);
    expect(first.articlesNew).toBe(1);

    const article = db
      .prepare(
        'SELECT id, url, read, saved, hidden, thumbs_up, thumbs_down FROM articles WHERE feed_id = ?',
      )
      .get('feed-ingest') as {
      id: string;
      url: string;
      read: number;
      saved: number;
      hidden: number;
      thumbs_up: number;
      thumbs_down: number;
    };
    expect(article.url).toBe('https://example.com/story?a=1&b=2');

    db.prepare(
      'UPDATE articles SET read = 1, saved = 1, hidden = 1, thumbs_up = 1, thumbs_down = 0 WHERE id = ?',
    ).run(article.id);

    const second = await ingestFeed({ feedId: 'feed-ingest' });
    expect(second.success).toBe(true);
    expect(second.articlesNew).toBe(0);
    expect(
      (
        db
          .prepare('SELECT COUNT(*) as count FROM articles WHERE feed_id = ?')
          .get('feed-ingest') as { count: number }
      ).count,
    ).toBe(1);

    const state = db
      .prepare(
        'SELECT read, saved, hidden, thumbs_up, thumbs_down FROM articles WHERE id = ?',
      )
      .get(article.id) as Omit<typeof article, 'id' | 'url'>;
    expect(state).toEqual({
      read: 1,
      saved: 1,
      hidden: 1,
      thumbs_up: 1,
      thumbs_down: 0,
    });

    const aiJobs = db
      .prepare(
        "SELECT COUNT(*) as count FROM jobs WHERE type = 'ai_process' AND json_extract(payload, '$.articleId') = ?",
      )
      .get(article.id) as { count: number };
    expect(aiJobs.count).toBe(1);
  });
});
