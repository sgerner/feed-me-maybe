import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

describe('feed article queries', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-feed-articles.db');
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

  it('returns only preference-model auto-hidden articles in hidden mode', async () => {
    const { getDb } = await import('$lib/server/db');
    const { getFeedArticles } = await import('./articles');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-1', 'https://example.com/rss', 'Example', now, now);

    const seedArticle = (
      id: string,
      hidden: number,
      publishedOffset: number,
      interactionMetadata: string | null,
    ) => {
      db.prepare(
        'INSERT OR REPLACE INTO articles (id, feed_id, url, title, hidden, published_at, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        'feed-1',
        `https://example.com/${id}`,
        id,
        hidden,
        now - publishedOffset,
        now - publishedOffset,
        now,
        now,
      );
      if (interactionMetadata) {
        db.prepare(
          'INSERT OR REPLACE INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
        ).run(
          `i-${id}`,
          id,
          'hide',
          now - publishedOffset,
          interactionMetadata,
        );
      }
    };

    seedArticle(
      'auto-model',
      1,
      1000,
      '{"auto":true,"reason":"preference_model"}',
    );
    seedArticle('auto-open', 1, 2000, '{"auto":true}');
    seedArticle('explicit-hide', 1, 3000, '{}');
    seedArticle('feed-clear', 1, 4000, null);
    seedArticle('visible', 0, 500, null);

    const result = getFeedArticles({
      feedId: 'feed-1',
      showHiddenContent: true,
    });

    expect(result.hiddenContentLimit).toBe(30);
    expect(result.totalArticles).toBe(1);
    expect(result.totalPages).toBe(1);
    expect(result.articles.map((article) => article.id)).toEqual(['auto-model']);
  });

  it('limits hidden content to the 30 most recent model-hidden articles', async () => {
    const { getDb } = await import('$lib/server/db');
    const { getFeedArticles } = await import('./articles');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-2', 'https://example.com/rss-2', 'Example 2', now, now);

    for (let i = 0; i < 31; i += 1) {
      const id = `model-${i.toString().padStart(2, '0')}`;
      const publishedAt = now - i * 1000;
      db.prepare(
        'INSERT OR REPLACE INTO articles (id, feed_id, url, title, hidden, published_at, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        'feed-2',
        `https://example.com/${id}`,
        id,
        1,
        publishedAt,
        publishedAt,
        now,
        now,
      );
      db.prepare(
        'INSERT OR REPLACE INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
      ).run(
        `i-${id}`,
        id,
        'hide',
        publishedAt,
        '{"auto":true,"reason":"preference_model"}',
      );
    }

    const result = getFeedArticles({
      feedId: 'feed-2',
      showHiddenContent: true,
    });

    expect(result.articles).toHaveLength(30);
    expect(result.articles[0]?.id).toBe('model-00');
    expect(result.articles[29]?.id).toBe('model-29');
    expect(result.totalArticles).toBe(31);
  });
});
