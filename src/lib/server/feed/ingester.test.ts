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
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
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
    db.prepare('DELETE FROM provider_configs').run();
    const { fetchFeed } = await import('./fetcher');
    vi.mocked(fetchFeed).mockReset();
  });

  it('does not commit a new ETag when article ingestion rolls back', async () => {
    const { fetchFeed } = await import('./fetcher');
    const { ingestFeed } = await import('./ingester');
    const { getDb } = await import('$lib/server/db');
    const { dispatchWebhookEvent } = await import('$lib/server/webhooks');
    vi.mocked(dispatchWebhookEvent).mockClear();
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, etag, last_modified_header, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'feed-etag-rollback',
      'https://example.com/etag.xml',
      'old-etag',
      'old-modified',
      'rss',
      now,
      now,
    );
    db.prepare(
      "CREATE TRIGGER fail_etag_ingest BEFORE INSERT ON articles WHEN NEW.guid = 'etag-second' BEGIN SELECT RAISE(ABORT, 'simulated article failure'); END",
    ).run();

    const response = {
      success: true,
      etag: 'new-etag',
      lastModified: 'new-modified',
      items: [
        {
          guid: 'etag-guid',
          url: 'https://example.com/etag-story',
          title: 'ETag Story',
          categories: [],
        },
        {
          guid: 'etag-second',
          url: 'https://example.com/etag-second',
          title: 'Second article',
          categories: [],
        },
      ],
    };
    vi.mocked(fetchFeed).mockResolvedValueOnce(response);

    try {
      const failed = await ingestFeed({ feedId: 'feed-etag-rollback' });
      expect(failed.success).toBe(false);
      expect(dispatchWebhookEvent).not.toHaveBeenCalled();
      expect(
        db
          .prepare('SELECT etag, last_modified_header FROM feeds WHERE id = ?')
          .get('feed-etag-rollback'),
      ).toEqual({ etag: 'old-etag', last_modified_header: 'old-modified' });
    } finally {
      db.prepare('DROP TRIGGER fail_etag_ingest').run();
    }

    vi.mocked(fetchFeed).mockResolvedValueOnce(response);
    const succeeded = await ingestFeed({ feedId: 'feed-etag-rollback' });
    expect(succeeded.success).toBe(true);
    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(2);
    expect(
      db
        .prepare('SELECT etag, last_modified_header FROM feeds WHERE id = ?')
        .get('feed-etag-rollback'),
    ).toEqual({ etag: 'new-etag', last_modified_header: 'new-modified' });
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
    const second = normalizeArticleUrl(
      'https://example.com/story?a=1&b=2#comments',
    );

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
      url: 'HTTPS://EXAMPLE.COM:443/story/?utm_campaign=test&b=2&a=1',
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
    expect(aiJobs.count).toBe(0);
  });

  it('keeps separate entries that share a page but use different anchors', async () => {
    const { fetchFeed } = await import('./fetcher');
    const { ingestFeed } = await import('./ingester');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('releases', 'https://example.com/releases.xml', now, now);
    vi.mocked(fetchFeed).mockResolvedValue({
      success: true,
      items: ['v1', 'v2'].map((version) => ({
        guid: version,
        url: `https://example.com/releases#${version}`,
        title: version,
        categories: [],
      })),
    });
    expect((await ingestFeed({ feedId: 'releases' })).articlesNew).toBe(2);
    expect((await ingestFeed({ feedId: 'releases' })).articlesNew).toBe(0);
    expect(
      db.prepare('SELECT url FROM articles ORDER BY url').pluck().all(),
    ).toEqual([
      'https://example.com/releases#v1',
      'https://example.com/releases#v2',
    ]);
  });

  it('skips image-only AI work and schedules enrichment when article text arrives', async () => {
    const { fetchFeed } = await import('./fetcher');
    const { ingestFeed } = await import('./ingester');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('stub-feed', 'https://example.com/stubs.rss', now, now);
    db.prepare(
      'INSERT INTO provider_configs (id, provider_id, model_id, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
    ).run('provider', 'test-provider', 'test-model', now, now);
    const item = {
      guid: 'stub',
      url: 'https://example.com/stub',
      title: 'Stub',
      categories: [],
      content: `<img src="https://example.com/${'x'.repeat(100)}.png">`,
    };
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      success: true,
      items: [item],
    });
    expect((await ingestFeed({ feedId: 'stub-feed' })).articlesNew).toBe(1);
    const count = db
      .prepare("SELECT COUNT(*) FROM jobs WHERE type = 'ai_process'")
      .pluck();
    expect(count.get()).toBe(0);

    vi.mocked(fetchFeed).mockResolvedValueOnce({
      success: true,
      items: [{ ...item, content: '<p>Readable text arrived.</p>' }],
    });
    expect((await ingestFeed({ feedId: 'stub-feed' })).articlesNew).toBe(0);
    expect(count.get()).toBe(1);
    expect(db.prepare('SELECT content FROM articles').pluck().get()).toBe(
      '<p>Readable text arrived.</p>',
    );
  });

  it('waits for enrichment before queueing the first ranking score', async () => {
    const { fetchFeed } = await import('./fetcher');
    const { ingestFeed } = await import('./ingester');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = Date.now();
    const originalJevApiKey = process.env.JEV_API_KEY;
    process.env.JEV_API_KEY = 'test-ranking-key';
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run(
      'feed-ai-before-jev',
      'https://example.com/ai-before-jev.rss',
      now,
      now,
    );
    db.prepare(
      'INSERT INTO provider_configs (id, provider_id, model_id, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
    ).run('provider-ai-before-jev', 'test-provider', 'test-model', now, now);
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      success: true,
      items: [
        {
          guid: 'story',
          url: 'https://example.com/ai-before-jev/story',
          title: 'A useful story',
          summary: 'A grounded summary.',
          categories: [],
        },
      ],
    });

    try {
      expect(
        (await ingestFeed({ feedId: 'feed-ai-before-jev' })).articlesNew,
      ).toBe(1);
      const counts = db
        .prepare(
          `SELECT type, COUNT(*) AS count FROM jobs
           WHERE type IN ('ai_process', 'jev_process') GROUP BY type`,
        )
        .all() as Array<{ type: string; count: number }>;
      expect(counts).toEqual([{ type: 'ai_process', count: 1 }]);
    } finally {
      if (originalJevApiKey === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = originalJevApiKey;
    }
  });

  it('preserves the UTF-16 content upgrade threshold during deduplication', async () => {
    const { fetchFeed } = await import('./fetcher');
    const { ingestFeed } = await import('./ingester');
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-content-upgrade', 'https://example.com/rss', 'rss', now, now);

    const item = {
      guid: 'stable-guid',
      url: 'https://example.com/story',
      title: 'Story',
      summary: 'Short summary',
      categories: [],
      publishedAt: new Date(now + 86_400_000),
    };
    const originalContent = '😀'.repeat(30);
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      success: true,
      items: [{ ...item, content: originalContent }],
    });
    await ingestFeed({ feedId: 'feed-content-upgrade' });

    vi.mocked(fetchFeed).mockResolvedValueOnce({
      success: true,
      items: [{ ...item, content: 'a'.repeat(110) }],
    });
    await ingestFeed({ feedId: 'feed-content-upgrade' });
    expect(
      db
        .prepare('SELECT content, published_at FROM articles WHERE feed_id = ?')
        .get('feed-content-upgrade'),
    ).toEqual({ content: originalContent, published_at: null });

    const upgradedContent = 'a'.repeat(111);
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      success: true,
      items: [{ ...item, content: upgradedContent, summary: 'Full summary' }],
    });
    const second = await ingestFeed({ feedId: 'feed-content-upgrade' });
    const article = db
      .prepare('SELECT content, summary FROM articles WHERE feed_id = ?')
      .get('feed-content-upgrade') as {
      content: string;
      summary: string;
    };

    expect(second.articlesNew).toBe(0);
    expect(article.content).toBe(upgradedContent);
    expect(article.summary).toBe('Full summary');
  });
});
