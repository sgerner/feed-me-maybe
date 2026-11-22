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

vi.mock('./fetcher', () => ({
  fetchFeed: vi.fn(),
}));
vi.mock('#lib/server/preferences.ts', () => ({
  applyPreferenceModelToArticle: vi.fn(),
  updateHeuristicScore: vi.fn(),
}));
vi.mock('#lib/server/webhooks.ts', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('#lib/server/realtime.ts', () => ({
  broadcast: vi.fn(),
}));
vi.mock('#lib/server/proxy.ts', () => ({
  getConfiguredProxyBaseUrl: () => undefined,
}));

describe('feed ingester identity and duplicate handling', () => {
  let testDb: TestDbHandle;

  beforeAll(() => {
    testDb = createTestDb('feed-me-maybe-ingester-');
  });

  beforeEach(async () => {
    testDb.reset();
    const { fetchFeed } = await import('./fetcher');
    vi.mocked(fetchFeed).mockReset();
  });

  it('does not commit a new ETag when article ingestion rolls back', async () => {
    const { fetchFeed } = await import('./fetcher');
    const { ingestFeed } = await import('./ingester');
    const { getDb } = await import('#lib/server/db/index.ts');
    const { dispatchWebhookEvent } = await import('#lib/server/webhooks.ts');
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

  afterAll(() => {
    testDb.cleanup();
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
    const { getDb } = await import('#lib/server/db/index.ts');
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
    const { getDb } = await import('#lib/server/db/index.ts');
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
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('stub-feed', 'https://example.com/stubs.rss', now, now);
    const { encrypt } = await import('#lib/server/ai/crypto.ts');
    const config = encrypt(JSON.stringify({ apiKey: 'fixture-key' }));
    db.prepare(
      'INSERT INTO provider_configs (id, provider_id, model_id, enabled, api_key_encrypted, api_key_nonce, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
    ).run(
      'provider',
      'test-provider',
      'test-model',
      config.encrypted,
      config.nonce,
      now,
      now,
    );
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
    const { getDb } = await import('#lib/server/db/index.ts');
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
    const { encrypt } = await import('#lib/server/ai/crypto.ts');
    const config = encrypt(JSON.stringify({ apiKey: 'fixture-key' }));
    db.prepare(
      'INSERT INTO provider_configs (id, provider_id, model_id, enabled, api_key_encrypted, api_key_nonce, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
    ).run(
      'provider-ai-before-jev',
      'test-provider',
      'test-model',
      config.encrypted,
      config.nonce,
      now,
      now,
    );
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
    const { getDb } = await import('#lib/server/db/index.ts');
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

  it('preserves ready AI metadata and combined_score on updates while AI is paused', async () => {
    const { fetchFeed } = await import('./fetcher');
    const { ingestFeed } = await import('./ingester');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-paused-ai', 'https://example.com/paused.xml', 'rss', now, now);
    db.prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('ai_enabled', 'false', ?) ON CONFLICT(key) DO UPDATE SET value = 'false'",
    ).run(now);
    db.prepare(
      `INSERT INTO articles (id, feed_id, guid, url, title, summary, content, heuristic_score, combined_score, fetched_at, created_at, updated_at)
       VALUES ('paused-art', 'feed-paused-ai', 'p1', 'https://example.com/p1', 'Paused Story', 'Summary', 'Initial short', 50, 72, ?, ?, ?)`,
    ).run(now, now, now);
    db.prepare(
      `INSERT INTO article_ai_metadata (id, article_id, summary, ai_relevance_score, quality_score, novelty_score, analysis_status, processed_at, created_at)
       VALUES ('meta-paused', 'paused-art', 'AI summary', 0.9, 0.8, 0.7, 'ready', ?, ?)`,
    ).run(now, now);

    vi.mocked(fetchFeed).mockResolvedValueOnce({
      success: true,
      items: [
        {
          guid: 'p1',
          url: 'https://example.com/p1',
          title: 'Paused Story',
          summary: 'Summary',
          content: 'a'.repeat(200),
          categories: [],
        },
      ],
    });

    await ingestFeed({ feedId: 'feed-paused-ai' });

    const meta = db
      .prepare(
        'SELECT analysis_status FROM article_ai_metadata WHERE article_id = ?',
      )
      .get('paused-art') as { analysis_status: string };
    const art = db
      .prepare('SELECT combined_score FROM articles WHERE id = ?')
      .get('paused-art') as { combined_score: number | null };
    expect(meta.analysis_status).toBe('ready');
    expect(art.combined_score).not.toBeNull();
  });

  it('skips disabled feeds without logging a fetch or calling fetchFeed', async () => {
    const { fetchFeed } = await import('./fetcher');
    const { ingestFeed } = await import('./ingester');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, enabled, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
    ).run('feed-disabled', 'https://example.com/disabled.xml', now, now);

    const result = await ingestFeed({ feedId: 'feed-disabled' });
    expect(result).toMatchObject({ success: true, skipped: true });
    expect(fetchFeed).not.toHaveBeenCalled();
    expect(
      db
        .prepare('SELECT COUNT(*) FROM feed_fetch_logs WHERE feed_id = ?')
        .pluck()
        .get('feed-disabled'),
    ).toBe(0);
  });

  it('marks fetch log as error if a pre-transaction fetch call throws', async () => {
    const { fetchFeed } = await import('./fetcher');
    const { ingestFeed } = await import('./ingester');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-pretx-throw', 'https://example.com/throw.xml', now, now);

    vi.mocked(fetchFeed).mockRejectedValueOnce(new Error('Pre-tx boom'));
    const failed = await ingestFeed({ feedId: 'feed-pretx-throw' });
    expect(failed.success).toBe(false);
    expect(failed.error).toContain('Pre-tx boom');

    const latestLog = db
      .prepare(
        'SELECT status, error_message FROM feed_fetch_logs WHERE feed_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get('feed-pretx-throw') as { status: string; error_message: string };
    expect(latestLog.status).toBe('error');
    expect(latestLog.error_message).toContain('Pre-tx boom');

    // Subsequent run must not get stuck on already_running.
    vi.mocked(fetchFeed).mockResolvedValueOnce({ success: true, items: [] });
    const recovered = await ingestFeed({ feedId: 'feed-pretx-throw' });
    expect(recovered.success).toBe(true);
    expect(recovered.status).toBe('completed');
  });

  it('orders undated items newest-first via descending fetched_at and treats non-unique GUIDs as null', async () => {
    const { fetchFeed } = await import('./fetcher');
    const { ingestFeed } = await import('./ingester');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-undated-guid', 'https://example.com/undated.xml', now, now);

    vi.mocked(fetchFeed).mockResolvedValueOnce({
      success: true,
      items: [
        {
          guid: 'reused-guid',
          url: 'https://example.com/post-newest',
          title: 'Newest',
          categories: [],
        },
        {
          guid: 'reused-guid',
          url: 'https://example.com/post-older',
          title: 'Older',
          categories: [],
        },
      ],
    });

    const result = await ingestFeed({ feedId: 'feed-undated-guid' });
    expect(result.articlesNew).toBe(2);

    const rows = db
      .prepare(
        'SELECT title, guid, fetched_at FROM articles WHERE feed_id = ? ORDER BY fetched_at DESC',
      )
      .all('feed-undated-guid') as Array<{
      title: string;
      guid: string;
      fetched_at: number;
    }>;
    expect(rows.map((r) => r.title)).toEqual(['Newest', 'Older']);
    expect(rows[0].fetched_at).toBeGreaterThan(rows[1].fetched_at);
    expect(rows.every((r) => r.guid === '')).toBe(true);
  });

  it('reconciles rotating /latest URLs in both orders without losing saved bookmarks, and syncs GUID title/summary edits to FTS5', async () => {
    const { fetchFeed } = await import('./fetcher');
    const { ingestFeed } = await import('./ingester');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-rotating', 'https://example.com/latest.xml', now, now);

    // Poll 1: Issue 1 at /latest, user saves it with Readability content.
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      success: true,
      items: [
        {
          guid: 'issue-1',
          url: 'https://example.com/latest',
          title: 'Issue One',
          summary: 'Summary One',
          content: '<p>Full saved Readability body for Issue One.</p>',
          categories: [],
        },
      ],
    });
    expect((await ingestFeed({ feedId: 'feed-rotating' })).articlesNew).toBe(1);
    db.prepare("UPDATE articles SET saved = 1 WHERE guid = 'issue-1'").run();

    // Poll 2 (Order 1: new Issue 2 at /latest BEFORE moved Issue 1 at /archive/1).
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      success: true,
      items: [
        {
          guid: 'issue-2',
          url: 'https://example.com/latest',
          title: 'Issue Two',
          summary: 'Summary Two',
          categories: [],
        },
        {
          guid: 'issue-1',
          url: 'https://example.com/archive/1',
          title: 'Issue One (Corrected)',
          summary: 'Summary One Updated',
          // Inflated HTML wrapper should not overwrite saved=1 body.
          content: '<div><span>' + 'x'.repeat(200) + '</span></div>',
          categories: ['release'],
        },
      ],
    });
    expect((await ingestFeed({ feedId: 'feed-rotating' })).articlesNew).toBe(1);

    const issue1 = db
      .prepare(
        'SELECT id, url, title, summary, content, categories FROM articles WHERE guid = ?',
      )
      .get('issue-1') as {
      id: string;
      url: string;
      title: string;
      summary: string;
      content: string;
      categories: string;
    };
    expect(issue1.url).toBe('https://example.com/archive/1');
    expect(issue1.title).toBe('Issue One (Corrected)');
    expect(issue1.summary).toBe('Summary One Updated');
    expect(issue1.content).toBe(
      '<p>Full saved Readability body for Issue One.</p>',
    );
    expect(JSON.parse(issue1.categories)).toEqual(['release']);

    // Verify FTS5 reflects updated headline.
    const ftsHit = db
      .prepare(
        "SELECT article_id FROM article_search WHERE article_search MATCH 'Corrected'",
      )
      .get() as { article_id: string } | undefined;
    expect(ftsHit?.article_id).toBe(issue1.id);

    // Poll 3 (Order 2: moved Issue 2 at /archive/2 BEFORE Issue 3 at /latest).
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      success: true,
      items: [
        {
          guid: 'issue-2',
          url: 'https://example.com/archive/2',
          title: 'Issue Two',
          categories: [],
        },
        {
          guid: 'issue-3',
          url: 'https://example.com/latest',
          title: 'Issue Three',
          categories: [],
        },
      ],
    });
    expect((await ingestFeed({ feedId: 'feed-rotating' })).articlesNew).toBe(1);

    // Poll 4: Issue 4 shares /latest without Issue 3 in the feed (distinct GUID + title).
    vi.mocked(fetchFeed).mockResolvedValueOnce({
      success: true,
      items: [
        {
          guid: 'issue-4',
          url: 'https://example.com/latest',
          title: 'Issue Four',
          categories: [],
        },
      ],
    });
    expect((await ingestFeed({ feedId: 'feed-rotating' })).articlesNew).toBe(1);
    expect(
      db
        .prepare('SELECT COUNT(*) FROM articles WHERE feed_id = ?')
        .pluck()
        .get('feed-rotating'),
    ).toBe(4);
  });

  it("backfills categories over '[]' and applies preference model on stub upgrade", async () => {
    const { fetchFeed } = await import('./fetcher');
    const { ingestFeed } = await import('./ingester');
    const { getDb } = await import('#lib/server/db/index.ts');
    const { applyPreferenceModelToArticle } =
      await import('#lib/server/preferences.ts');
    vi.mocked(applyPreferenceModelToArticle).mockClear();
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-cat-backfill', 'https://example.com/cat.xml', now, now);
    db.prepare(
      `INSERT INTO articles (id, feed_id, guid, url, title, summary, content, categories, fetched_at, created_at, updated_at)
       VALUES ('cat-art', 'feed-cat-backfill', 'c1', 'https://example.com/c1', 'Stub Title', 'Stub', '', '[]', ?, ?, ?)`,
    ).run(now, now, now);

    vi.mocked(fetchFeed).mockResolvedValueOnce({
      success: true,
      items: [
        {
          guid: 'c1',
          url: 'https://example.com/c1',
          title: 'Stub Title',
          summary: 'Stub',
          content: '<p>Full text body arrived for stub upgrade.</p>',
          categories: ['systems', 'rust'],
        },
      ],
    });

    await ingestFeed({ feedId: 'feed-cat-backfill' });
    expect(
      db
        .prepare('SELECT categories FROM articles WHERE id = ?')
        .pluck()
        .get('cat-art'),
    ).toBe('["systems","rust"]');
    expect(applyPreferenceModelToArticle).toHaveBeenCalledWith('cat-art');
  });

  it('defers sanitizeHtml on unchanged articles during repeated polls and does not overwrite Readability content with HTML-inflated stubs', async () => {
    const { fetchFeed } = await import('./fetcher');
    const { attachLazySanitizedBodies } =
      await vi.importActual<typeof import('./fetcher')>('./fetcher');
    const formatMod = await import('#lib/utils/format.ts');
    const { ingestFeed } = await import('./ingester');
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('feed-lazy-sanitize', 'https://example.com/lazy.xml', now, now);

    const makeItem = (rawContent: string, rawSummary = 'Plain summary') =>
      attachLazySanitizedBodies(
        {
          guid: 'lazy-1',
          url: 'https://example.com/lazy-1',
          title: 'Lazy Post',
          categories: [],
        },
        {
          rawSummary,
          summaryBase: 'https://example.com/lazy-1',
          rawContent,
          contentBase: 'https://example.com/lazy-1',
        },
      );

    const sanitizeSpy = vi.spyOn(formatMod, 'sanitizeHtml');
    try {
      vi.mocked(fetchFeed).mockResolvedValueOnce({
        success: true,
        items: [
          makeItem(
            '<p>Clean Readability article text with meaningful prose that should never be replaced by tag-bloated short snippets.</p>',
          ),
        ],
      });
      expect(
        (await ingestFeed({ feedId: 'feed-lazy-sanitize' })).articlesNew,
      ).toBe(1);
      expect(sanitizeSpy).toHaveBeenCalled();

      // Poll 2: identical item should not run sanitizeHtml at all
      sanitizeSpy.mockClear();
      vi.mocked(fetchFeed).mockResolvedValueOnce({
        success: true,
        items: [
          makeItem(
            '<p>Clean Readability article text with meaningful prose that should never be replaced by tag-bloated short snippets.</p>',
          ),
        ],
      });
      expect(
        (await ingestFeed({ feedId: 'feed-lazy-sanitize' })).articlesNew,
      ).toBe(0);
      expect(sanitizeSpy).not.toHaveBeenCalled();

      // Poll 3: HTML-bloated stub (longer HTML bytes, shorter plain text) must not overwrite cleaner content
      vi.mocked(fetchFeed).mockResolvedValueOnce({
        success: true,
        items: [
          makeItem(
            '<div><span><b><i><u>'.repeat(10) +
              'Short stub' +
              '</u></i></b></span></div>'.repeat(10),
          ),
        ],
      });
      await ingestFeed({ feedId: 'feed-lazy-sanitize' });
      expect(
        db
          .prepare('SELECT content FROM articles WHERE feed_id = ?')
          .pluck()
          .get('feed-lazy-sanitize'),
      ).toContain('Clean Readability article text with meaningful prose');
    } finally {
      sanitizeSpy.mockRestore();
    }
  });
});
