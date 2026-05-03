import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

describe('settings API mutations', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-settings-api.db');
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

  it('deletes a specific preference via delete_pref_* key', async () => {
    const { getDb } = await import('$lib/server/db');
    const { applySettingsMutation } = await import('$lib/server/settings');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'pref-1',
      'topic:obituary',
      'topic',
      'negative',
      0.7,
      2,
      now,
      '',
      now,
    );

    const result = applySettingsMutation('delete_pref_pref-1', 'true');
    const row = db
      .prepare('SELECT id FROM user_preference_memory WHERE id = ?')
      .get('pref-1');

    expect(result.success).toBe(true);
    expect(row).toBeUndefined();
  });

  it('resets training data and article interaction state', async () => {
    const { getDb } = await import('$lib/server/db');
    const { applySettingsMutation } = await import('$lib/server/settings');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-1', 'https://example.com/rss', 'Example', now, now);
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, hidden, read, saved, thumbs_up, thumbs_down, heuristic_score, combined_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'article-1',
      'feed-1',
      'https://example.com/a1',
      'A1',
      1,
      1,
      1,
      1,
      0,
      92,
      88,
      now,
      now,
      now,
    );
    db.prepare(
      'INSERT OR REPLACE INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run('i-1', 'article-1', 'hide', now, '{}');
    db.prepare(
      'INSERT OR REPLACE INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'pref-2',
      'topic:obituary',
      'topic',
      'negative',
      0.9,
      5,
      now,
      '',
      now,
    );
    db.prepare(
      'INSERT OR REPLACE INTO article_ai_metadata (id, article_id, summary, topics, entities, content_type, ai_relevance_score, explanation, processed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('meta-1', 'article-1', '', '[]', '[]', 'news', 0.1, '', now, now);

    const result = applySettingsMutation('reset_training', 'true');
    const interactions = db
      .prepare('SELECT COUNT(*) as c FROM user_interactions')
      .get() as { c: number };
    const prefs = db
      .prepare('SELECT COUNT(*) as c FROM user_preference_memory')
      .get() as { c: number };
    const aiMeta = db
      .prepare('SELECT COUNT(*) as c FROM article_ai_metadata')
      .get() as { c: number };
    const article = db
      .prepare(
        'SELECT hidden, read, saved, thumbs_up, thumbs_down, heuristic_score, combined_score FROM articles WHERE id = ?',
      )
      .get('article-1') as Record<string, number>;

    expect(result.success).toBe(true);
    expect(interactions.c).toBe(0);
    expect(prefs.c).toBe(0);
    expect(aiMeta.c).toBe(0);
    expect(article.hidden).toBe(0);
    expect(article.read).toBe(0);
    expect(article.saved).toBe(0);
    expect(article.thumbs_up).toBe(0);
    expect(article.thumbs_down).toBe(0);
    expect(article.heuristic_score).toBe(50);
    expect(article.combined_score).toBe(0);
  });
});
