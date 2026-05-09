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
    db.prepare("DELETE FROM app_settings WHERE key = 'weekly_digest_cache'").run();
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
      .prepare("SELECT value FROM app_settings WHERE key = 'weekly_digest_cache'")
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
    expect(result.themes[0]?.summary).toBe('Objects should not leak into the UI');
    expect(result.topStories[0]?.reason).toBe('Representative article from the week');
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
    expect(themeNames.every((name) => {
      const words = name.split(/\s+/).filter(Boolean).length;
      return words >= 2 && words <= 3;
    })).toBe(true);
    expect(themeNames[0]).not.toMatch(/^(Nyt|Codex|Question|Complaint)$/i);
  });
});
