import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

describe('feed management', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-feed-management.db');
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

  it('clears feed articles without deleting learned preferences', async () => {
    const { getDb } = await import('$lib/server/db');
    const { clearFeedArticles } = await import('./feed-management');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-clear', 'https://example.com/rss', 'Clear Feed', now, now);
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'article-clear',
      'feed-clear',
      'https://example.com/a',
      'Article',
      now,
      now,
      now,
    );
    db.prepare(
      'INSERT OR REPLACE INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run('interaction-clear', 'article-clear', 'hide', now, '{}');
    db.prepare(
      'INSERT OR REPLACE INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'pref-clear',
      'topic:obituary',
      'topic',
      'negative',
      0.8,
      3,
      now,
      '',
      now,
    );

    const deleted = clearFeedArticles('feed-clear');
    const articles = db
      .prepare('SELECT COUNT(*) as c FROM articles WHERE feed_id = ? AND hidden = 0')
      .get('feed-clear') as {
      c: number;
    };
    const totalArticles = db
      .prepare('SELECT COUNT(*) as c FROM articles WHERE feed_id = ?')
      .get('feed-clear') as {
      c: number;
    };
    const interactions = db
      .prepare(
        'SELECT COUNT(*) as c FROM user_interactions WHERE article_id = ?',
      )
      .get('article-clear') as {
      c: number;
    };
    const pref = db
      .prepare('SELECT COUNT(*) as c FROM user_preference_memory WHERE id = ?')
      .get('pref-clear') as {
      c: number;
    };

    expect(deleted).toBe(1);
    expect(articles.c).toBe(0); // None are visible
    expect(totalArticles.c).toBe(1); // Still in DB
    expect(interactions.c).toBe(1); // Interactions preserved
    expect(pref.c).toBe(1);
  });
});
