import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

describe('interaction side effects', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-interactions.db');
  const originalDbUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbPath;
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const { initializeDatabase } = await import('$lib/server/db/migrate');
    initializeDatabase();
  });

  afterAll(async () => {
    const { closeDb } = await import('$lib/server/db');
    closeDb();
    process.env.DATABASE_URL = originalDbUrl ?? '';
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
  });

  it('hides an article when it is thumbed down', async () => {
    const { getDb } = await import('$lib/server/db');
    const { recordInteraction } = await import('./interactions');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-interactions', 'https://example.com/rss', 'Example', now, now);
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'article-interactions',
      'feed-interactions',
      'https://example.com/articles/1',
      'Interaction Article',
      now,
      now,
      now,
    );

    recordInteraction('article-interactions', 'thumbs_down');

    const article = db
      .prepare('SELECT hidden, thumbs_up, thumbs_down FROM articles WHERE id = ?')
      .get('article-interactions') as {
      hidden: number;
      thumbs_up: number;
      thumbs_down: number;
    };
    const interaction = db
      .prepare(
        'SELECT interaction_type FROM user_interactions WHERE article_id = ? ORDER BY timestamp DESC LIMIT 1',
      )
      .get('article-interactions') as { interaction_type: string };

    expect(article.hidden).toBe(1);
    expect(article.thumbs_up).toBe(0);
    expect(article.thumbs_down).toBe(1);
    expect(interaction.interaction_type).toBe('thumbs_down');
  });
});
