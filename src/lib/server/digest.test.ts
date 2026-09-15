import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

describe('weekly digest', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-weekly-digest.db');
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
    db.prepare(
      "DELETE FROM app_settings WHERE key = 'weekly_digest_cache'",
    ).run();
    db.prepare('DELETE FROM user_interactions').run();
    db.prepare('DELETE FROM article_ai_metadata').run();
    db.prepare('DELETE FROM articles').run();
    db.prepare('DELETE FROM feeds').run();
  });

  afterAll(async () => {
    const { closeDb } = await import('$lib/server/db');
    closeDb();
    process.env.DATABASE_URL = originalDbUrl ?? '';
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
  });

  it('summarizes the last 7 days and reuses the weekly cache', async () => {
    const { getDb } = await import('$lib/server/db');
    const { getWeeklyDigestArticles } = await import('./digest');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-1', 'https://example.com/rss', 'Example One', now, now);
    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-2', 'https://example.com/rss-2', 'Example Two', now, now);

    const seedArticle = (
      id: string,
      feedId: string,
      title: string,
      summary: string,
      score: number,
      publishedOffsetDays: number,
      read = 0,
      saved = 0,
      hidden = 0,
      categories = '["news"]',
    ) => {
      const publishedAt = now - publishedOffsetDays * 24 * 60 * 60 * 1000;
      db.prepare(
        'INSERT OR REPLACE INTO articles (id, feed_id, url, title, summary, hidden, read, saved, published_at, fetched_at, heuristic_score, combined_score, categories, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        feedId,
        `https://example.com/${id}`,
        title,
        summary,
        hidden,
        read,
        saved,
        publishedAt,
        publishedAt,
        score,
        score,
        categories,
        now,
        now,
      );
    };

    seedArticle(
      'recent-high',
      'feed-1',
      'Major update arrives',
      'A major update rolled out this week.',
      95,
      1,
      0,
      1,
      0,
      '["ai","release"]',
    );
    seedArticle(
      'recent-low',
      'feed-2',
      'Secondary story',
      'A smaller but relevant follow-up.',
      35,
      2,
      1,
      0,
      0,
      '["policy"]',
    );
    seedArticle(
      'stale-story',
      'feed-2',
      'Too old',
      'Should not appear in the digest window.',
      100,
      10,
      0,
      0,
      0,
      '["old"]',
    );

    const first = await getWeeklyDigestArticles(now);
    expect(first.cacheHit).toBe(false);
    expect(first.totalArticles).toBe(2);
    expect(first.totalFeeds).toBe(2);
    expect(first.topStories.length).toBeGreaterThan(0);
    expect(first.missedStories.length).toBeGreaterThan(0);
    expect(first.themes.length).toBeGreaterThan(0);
    expect(first.summary).toBeTruthy();

    const second = await getWeeklyDigestArticles(now);
    expect(second.cacheHit).toBe(true);
    expect(second.headline).toBe(first.headline);
    expect(second.topStories.map((story) => story.article.id)).toEqual(
      first.topStories.map((story) => story.article.id),
    );
  });

  it('includes read articles hidden on open, but excludes thumbs-down and unread-hidden articles', async () => {
    const { getDb } = await import('$lib/server/db');
    const { getWeeklyDigestArticles } = await import('./digest');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-1', 'https://example.com/rss', 'Example Feed', now, now);

    const seedArticle = (
      id: string,
      title: string,
      read: number,
      hidden: number,
      score: number,
      thumbsDown = 0,
    ) => {
      const publishedAt = now - 2 * 24 * 60 * 60 * 1000;
      db.prepare(
        'INSERT OR REPLACE INTO articles (id, feed_id, url, title, summary, hidden, read, thumbs_down, published_at, fetched_at, heuristic_score, combined_score, categories, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        'feed-1',
        `https://example.com/${id}`,
        title,
        `${title} summary`,
        hidden,
        read,
        thumbsDown,
        publishedAt,
        publishedAt,
        score,
        score,
        '["news"]',
        now,
        now,
      );
    };

    seedArticle('hidden-read', 'Read article hidden on open', 1, 1, 95);
    seedArticle('visible-unread', 'Unread article still visible', 0, 0, 90);
    seedArticle(
      'thumbs-down-visible',
      'Visible article with thumbs down',
      0,
      0,
      85,
      1,
    );
    seedArticle(
      'thumbs-down-hidden-read',
      'Hidden read article with thumbs down',
      1,
      1,
      80,
      1,
    );
    seedArticle(
      'hidden-unread',
      'Unread article hidden without being read',
      0,
      1,
      75,
    );

    const result = await getWeeklyDigestArticles(now);

    expect(result.totalArticles).toBe(2);
    expect(result.unreadArticles).toBe(1);
    expect(result.allArticles.map((article) => article.id)).toEqual([
      'hidden-read',
      'visible-unread',
    ]);
    expect(result.allArticles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'hidden-read', read: 1, hidden: 1 }),
        expect.objectContaining({ id: 'visible-unread', read: 0, hidden: 0 }),
      ]),
    );
    expect(result.allArticles.map((article) => article.id)).not.toEqual(
      expect.arrayContaining([
        'thumbs-down-visible',
        'thumbs-down-hidden-read',
        'hidden-unread',
      ]),
    );
    expect(result.topStories.map((story) => story.article.id)).toEqual([
      'hidden-read',
      'visible-unread',
    ]);
    expect(result.missedStories.map((story) => story.article.id)).toEqual([
      'visible-unread',
      'hidden-read',
    ]);
    expect(
      [...result.topStories, ...result.missedStories].map(
        (story) => story.article.id,
      ),
    ).not.toEqual(
      expect.arrayContaining([
        'thumbs-down-visible',
        'thumbs-down-hidden-read',
        'hidden-unread',
      ]),
    );
  });

  it('normalizes malformed cached ai text fields', async () => {
    const { getDb } = await import('$lib/server/db');
    const { getWeeklyDigestArticles } = await import('./digest');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-1', 'https://example.com/rss', 'Example One', now, now);

    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, summary, hidden, read, saved, published_at, fetched_at, heuristic_score, combined_score, categories, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'recent-high',
      'feed-1',
      'Major update arrives',
      'A major update rolled out this week.',
      0,
      0,
      0,
      1,
      now,
      now,
      95,
      95,
      '["ai","release"]',
      now,
      now,
    );

    await getWeeklyDigestArticles(now);

    const cacheRow = db
      .prepare(
        "SELECT value FROM app_settings WHERE key = 'weekly_digest_cache'",
      )
      .get() as { value: string } | undefined;
    expect(cacheRow).toBeTruthy();

    const cache = JSON.parse(cacheRow?.value || '{}');
    cache.raw.themes = [
      {
        name: { text: 'Weekly AI Theme' },
        summary: { text: 'Objects should not leak into the UI' },
        articleIds: [{ text: 'recent-high' }],
      },
    ];
    cache.raw.topStories = [
      {
        articleId: { text: 'recent-high' },
        reason: { text: 'Representative article from the week' },
      },
    ];
    cache.raw.missedStories = [
      {
        articleId: { text: 'recent-high' },
        reason: { text: 'Worth a quick look' },
      },
    ];

    db.prepare(
      "UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'weekly_digest_cache'",
    ).run(JSON.stringify(cache), now);

    const result = await getWeeklyDigestArticles(now);
    expect(result.cacheHit).toBe(true);
    expect(result.themes[0]?.name).toBe('Weekly AI Theme');
    expect(result.themes[0]?.summary).toBe(
      'Objects should not leak into the UI',
    );
    expect(result.topStories[0]?.reason).toBe(
      'Representative article from the week',
    );
    expect(result.missedStories[0]?.reason).toBe('Worth a quick look');
    expect(result.takeaways.join(' ')).not.toMatch(/Object Object/i);
  });

  it('ignores object-shaped categories when deriving heuristic themes', async () => {
    const { getDb } = await import('$lib/server/db');
    const { getWeeklyDigestArticles } = await import('./digest');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-1', 'https://example.com/rss', 'Example One', now, now);

    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, summary, hidden, read, saved, published_at, fetched_at, heuristic_score, combined_score, categories, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'recent-high',
      'feed-1',
      'Major update arrives',
      'A major update rolled out this week.',
      0,
      0,
      0,
      1,
      now,
      now,
      95,
      95,
      '[{"label":"ai"},{"name":"release"}]',
      now,
      now,
    );

    const result = await getWeeklyDigestArticles(now);
    const themeNames = result.themes.map((theme) => theme.name);
    expect(themeNames).not.toContain('Object Object');
    expect(
      themeNames.every((name) => {
        const words = name.split(/\s+/).filter(Boolean).length;
        return words >= 2 && words <= 3;
      }),
    ).toBe(true);
    expect(themeNames[0]).not.toMatch(/^(Nyt|Codex|Question|Complaint)$/i);
  });

  it('deduplicates related coverage while retaining every eligible article', async () => {
    const { deduplicateDigestArticles } = await import('./digest');
    const article = (
      id: string,
      title: string,
      url: string,
      feedId: string,
    ) => ({
      id,
      feed_id: feedId,
      url,
      title,
      author: null,
      summary: `${title} summary`,
      image_url: null,
      categories: '[]',
      published_at: Date.now(),
      fetched_at: Date.now(),
      read: 0,
      saved: 0,
      hidden: 0,
      thumbs_up: 0,
      thumbs_down: 0,
      heuristic_score: id === 'lead' ? 90 : 40,
      combined_score: id === 'lead' ? 90 : 40,
      feed_title: feedId,
      feed_url: url,
      feed_open_mode: 'app',
    });

    const result = deduplicateDigestArticles([
      article(
        'lead',
        'City council approves clean energy plan',
        'https://one.example/story',
        'one',
      ),
      article(
        'related',
        'City council approves clean energy plan',
        'https://two.example/story?utm_source=feed',
        'two',
      ),
      article(
        'different',
        'Local museum opens a new exhibit',
        'https://three.example/story',
        'three',
      ),
    ]);

    expect(result.representatives.map((item) => item.id)).toEqual([
      'lead',
      'different',
    ]);
    expect(result.clusters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          representativeId: 'lead',
          articleIds: ['lead', 'related'],
          feedIds: ['one', 'two'],
        }),
      ]),
    );
  });

  it('normalizes calm briefing output and preserves status and uncertainty', async () => {
    const { normalizeCalmBriefingResponse } = await import('./digest');
    const result = normalizeCalmBriefingResponse({
      headline: 'A measured update',
      summary: 'Two developments are worth a look.',
      topSignal: [
        {
          articleId: 'a1',
          reason: '<b>New context</b>',
          status: 'new',
          uncertainty: 'Details are still developing.',
        },
      ],
      worthYourTime: [
        { articleId: 'a2', reason: 'Useful context', status: 'ongoing' },
      ],
      whatChanged: [
        { articleId: 'a3', reason: 'A new release', status: 'new' },
      ],
      uncertainty: ['The supplied sources do not agree on timing.'],
      themes: [
        {
          name: 'Clean Energy',
          summary: 'Related coverage.',
          articleIds: ['a1', 'a2'],
        },
      ],
    });

    expect(result?.topSignal?.[0]).toEqual(
      expect.objectContaining({ articleId: 'a1', status: 'new' }),
    );
    expect(result?.topSignal?.[0]?.uncertainty).toContain(
      'Details are still developing',
    );
    expect(result?.worthYourTime?.[0]?.status).toBe('ongoing');
    expect(result?.uncertainty).toEqual([
      'The supplied sources do not agree on timing.',
    ]);
    expect(result?.topStories).toEqual(result?.topSignal);
  });

  it('builds a deterministic briefing from the full eligible corpus without AI', async () => {
    const { getDb } = await import('$lib/server/db');
    const { getWeeklyDigestArticles } = await import('./digest');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-1', 'https://example.com/rss', 'Example Feed', now, now);

    const insert = (id: string, title: string, read: number, hidden: number) =>
      db
        .prepare(
          'INSERT OR REPLACE INTO articles (id, feed_id, url, title, summary, hidden, read, published_at, fetched_at, heuristic_score, combined_score, categories, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          'feed-1',
          `https://example.com/${id}`,
          title,
          `${title} summary`,
          hidden,
          read,
          now - 60 * 60 * 1000,
          now - 60 * 60 * 1000,
          70,
          70,
          '["news"]',
          now,
          now,
        );

    insert('read-hidden', 'A read story remains useful', 1, 1);
    insert('unread-visible', 'A new story needs a look', 0, 0);

    const result = await getWeeklyDigestArticles({
      now,
      windowDays: 3,
      forceRefresh: true,
    });
    expect(result.windowDays).toBe(3);
    expect(result.inclusionCounts).toEqual(
      expect.objectContaining({
        eligibleArticles: 2,
        read: 1,
        unread: 1,
        hiddenRead: 1,
      }),
    );
    expect(result.allArticles.map((item) => item.id)).toEqual([
      'read-hidden',
      'unread-visible',
    ]);
    expect(result.briefing.topSignal.length).toBeGreaterThan(0);
    expect(result.briefing.whatChanged.length).toBeGreaterThan(0);
    expect(
      result.allArticles.every((item) => item.url.startsWith('https://')),
    ).toBe(true);
  });
});
