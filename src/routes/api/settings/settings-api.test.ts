import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { POST } from './+server';

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
    const { getRankingFeedbackRevision } =
      await import('$lib/server/ranking-freshness');
    const db = getDb();
    const now = Date.now();
    const revision = getRankingFeedbackRevision();

    db.prepare(
      'INSERT INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'delete-pref-feed',
      'https://example.com/delete-pref.xml',
      'Delete Preference',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO articles
         (id, feed_id, url, title, jev_score, heuristic_score, combined_score,
          fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'delete-pref-article',
      'delete-pref-feed',
      'https://example.com/delete-pref-article',
      'Preference target',
      0.91,
      78,
      88,
      now,
      now,
      now,
    );

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
    expect(getRankingFeedbackRevision()).toBe(revision + 1);
    expect(
      db
        .prepare('SELECT jev_score FROM articles WHERE id = ?')
        .get('delete-pref-article'),
    ).toEqual({ jev_score: null });
    expect(
      db
        .prepare(
          'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
        )
        .get('delete-pref-article'),
    ).toEqual({ article_id: 'delete-pref-article' });
  });

  it('selects a ranking provider through the settings API without returning key material', async () => {
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'ranking-feed',
      'https://example.com/ranking.xml',
      'Ranking',
      now,
      now,
    );
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, jev_score, heuristic_score, combined_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'ranking-article',
      'ranking-feed',
      'https://example.com/ranking-article',
      'Article',
      0.91,
      50,
      77,
      now,
      now,
      now,
    );

    const response = await POST({
      request: new Request('http://localhost/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'ranking_provider', value: 'subq' }),
      }),
      locals: { sessionId: 'test-session' },
    } as Parameters<typeof POST>[0]);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      success: true,
      provider: 'subq',
      changed: true,
    });
    expect(Object.keys(payload).sort()).toEqual(
      ['changed', 'configured', 'message', 'provider', 'success'].sort(),
    );
    expect(
      db
        .prepare(
          "SELECT value FROM app_settings WHERE key = 'ranking_provider'",
        )
        .get(),
    ).toEqual({ value: 'subq' });
    expect(
      db
        .prepare('SELECT jev_score FROM articles WHERE id = ?')
        .get('ranking-article'),
    ).toEqual({ jev_score: null });
    expect(
      db
        .prepare(
          'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
        )
        .get('ranking-article'),
    ).toEqual({ article_id: 'ranking-article' });
  });

  it('resets learned ranking inputs while preserving article state and metadata', async () => {
    const { getDb } = await import('$lib/server/db');
    const { applySettingsMutation } = await import('$lib/server/settings');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-1', 'https://example.com/rss', 'Example', now, now);
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, hidden, read, saved, saved_at, thumbs_up, thumbs_down, heuristic_score, combined_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'article-1',
      'feed-1',
      'https://example.com/a1',
      'A1',
      1,
      1,
      1,
      now,
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
      'INSERT OR REPLACE INTO article_ai_metadata (id, article_id, summary, topics, entities, content_type, ai_relevance_score, explanation, analysis_status, processed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'meta-1',
      'article-1',
      '',
      '[]',
      '[]',
      'news',
      0.1,
      '',
      'ready',
      now,
      now,
    );

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
        'SELECT hidden, read, saved, saved_at, thumbs_up, thumbs_down, rejected, jev_score, heuristic_score, combined_score FROM articles WHERE id = ?',
      )
      .get('article-1') as Record<string, number>;

    expect(result.success).toBe(true);
    expect(interactions.c).toBe(0);
    expect(prefs.c).toBe(0);
    expect(aiMeta.c).toBe(1);
    expect(article.hidden).toBe(1);
    expect(article.read).toBe(1);
    expect(article.saved).toBe(1);
    expect(article.saved_at).toBe(now);
    expect(article.thumbs_up).toBe(1);
    expect(article.thumbs_down).toBe(0);
    expect(article.rejected).toBe(0);
    expect(article.jev_score).toBeNull();
    expect(Number.isFinite(article.heuristic_score)).toBe(true);
    expect(Number.isFinite(article.combined_score)).toBe(true);
    expect(
      db
        .prepare(
          'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
        )
        .get('article-1'),
    ).toBeUndefined();
  });

  it('rolls back the entire training reset when an article update fails', async () => {
    const { getDb } = await import('$lib/server/db');
    const { applySettingsMutation } = await import('$lib/server/settings');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'reset-rollback-feed',
      'https://example.com/reset.xml',
      'Reset',
      now,
      now,
    );
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, hidden, read, saved, thumbs_down, heuristic_score, combined_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, 1, 1, 90, 80, ?, ?, ?)',
    ).run(
      'reset-rollback-article',
      'reset-rollback-feed',
      'https://example.com/reset-article',
      'Reset article',
      now,
      now,
      now,
    );
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'reset-rollback-interaction',
      'reset-rollback-article',
      'hide',
      now,
      '{}',
    );
    db.prepare(
      'INSERT INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'reset-rollback-pref',
      'topic:rollback',
      'topic',
      'negative',
      0.9,
      1,
      now,
      '',
      now,
    );
    db.prepare(
      "CREATE TRIGGER fail_training_reset BEFORE UPDATE OF jev_score ON articles BEGIN SELECT RAISE(ABORT, 'simulated reset failure'); END",
    ).run();

    try {
      expect(() => applySettingsMutation('reset_training', 'true')).toThrow(
        'simulated reset failure',
      );
    } finally {
      db.prepare('DROP TRIGGER fail_training_reset').run();
    }

    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM user_interactions WHERE id = ?')
        .get('reset-rollback-interaction'),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM user_preference_memory WHERE id = ?',
        )
        .get('reset-rollback-pref'),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare('SELECT hidden, read, saved FROM articles WHERE id = ?')
        .get('reset-rollback-article'),
    ).toEqual({ hidden: 1, read: 1, saved: 1 });
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM ranking_refresh_queue WHERE article_id = ?',
        )
        .get('reset-rollback-article'),
    ).toEqual({ count: 0 });
  });

  it('unhides preference_model auto-hides on delete_pref_ and reset_training while preserving manual hides, and sorts memory by decayed strength', async () => {
    const { getDb } = await import('$lib/server/db');
    const { applySettingsMutation } = await import('$lib/server/settings');
    const { load } = await import('../../settings/memory/+page.server');
    const db = getDb();
    db.prepare('DELETE FROM user_preference_memory').run();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-pref-del', 'https://example.com/pdel.xml', 'PDel', now, now);
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, categories, hidden, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
    ).run(
      'auto-hide-1',
      'feed-pref-del',
      'https://example.com/ah1',
      'Auto hide target',
      '["Obits"]',
      now,
      now,
      now,
    );
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, categories, hidden, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
    ).run(
      'manual-hide-1',
      'feed-pref-del',
      'https://example.com/mh1',
      'Manual hide target',
      '["Obits"]',
      now,
      now,
      now,
    );
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'ah1-evt',
      'auto-hide-1',
      'hide',
      now,
      '{"auto":true,"reason":"preference_model"}',
    );
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run('mh1-evt', 'manual-hide-1', 'hide', now, '{}');

    db.prepare(
      'INSERT OR REPLACE INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('del-p1', 'topic:obits', 'topic', 'negative', 1.0, 4, now, '', now);
    db.prepare(
      'INSERT OR REPLACE INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'stale-p2',
      'topic:stale_topic',
      'topic',
      'positive',
      1.0,
      5,
      now - 180 * 24 * 60 * 60 * 1000,
      '',
      now - 180 * 24 * 60 * 60 * 1000,
    );

    const loaded = (await load({ locals: { sessionId: 's' } } as never)) as {
      preferences: Array<{ id: string; strength: number }>;
    };
    expect(loaded.preferences[0]?.id).toBe('del-p1');
    expect(loaded.preferences[1]?.id).toBe('stale-p2');
    expect(loaded.preferences[1]!.strength).toBeLessThan(0.2);

    applySettingsMutation('delete_pref_del-p1', 'true');
    expect(
      db.prepare('SELECT hidden FROM articles WHERE id = ?').get('auto-hide-1'),
    ).toEqual({ hidden: 0 });
    expect(
      db
        .prepare('SELECT hidden FROM articles WHERE id = ?')
        .get('manual-hide-1'),
    ).toEqual({ hidden: 1 });

    // Re-arm auto-hide and test selective unhide on reset_training
    db.prepare('UPDATE articles SET hidden = 1 WHERE id = ?').run(
      'auto-hide-1',
    );
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'ah1-evt-2',
      'auto-hide-1',
      'hide',
      now + 1,
      '{"auto":true,"reason":"preference_model"}',
    );
    applySettingsMutation('reset_training', 'true');
    expect(
      db.prepare('SELECT hidden FROM articles WHERE id = ?').get('auto-hide-1'),
    ).toEqual({ hidden: 0 });
    expect(
      db
        .prepare('SELECT hidden FROM articles WHERE id = ?')
        .get('manual-hide-1'),
    ).toEqual({ hidden: 1 });
  });
});
