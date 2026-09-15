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
      .prepare(
        'SELECT COUNT(*) as c FROM articles WHERE feed_id = ? AND hidden = 0',
      )
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

  it('normalizes feed URLs without changing meaningful query parameters', async () => {
    const { normalizeFeedUrl } = await import('./feed-management');

    expect(
      normalizeFeedUrl('HTTPS://EXAMPLE.COM:443/rss/?b=2&a=1#tracking'),
    ).toBe('https://example.com/rss?a=1&b=2');
  });

  it('calculates adaptive polling intervals', async () => {
    const { getEffectivePollIntervalMins } = await import('./feed-management');

    expect(getEffectivePollIntervalMins(null, 0, 15)).toBe(15);
    expect(getEffectivePollIntervalMins(5, 11, 15)).toBe(10);
    expect(getEffectivePollIntervalMins(5, 51, 15)).toBe(20);
  });

  it('reports healthy, stale, and error feed states with next due time', async () => {
    const { getDb } = await import('$lib/server/db');
    const { getFeedHealth } = await import('./feed-management');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      `
        INSERT OR REPLACE INTO feeds (
          id, url, enabled, poll_interval_mins, fetch_count_since_change,
          error_count, last_fetch_status, last_fetch_at, last_error,
          created_at, updated_at
        ) VALUES (?, ?, 1, ?, 0, 0, 'success', ?, '', ?, ?)
      `,
    ).run(
      'feed-health',
      'https://example.com/health',
      15,
      now - 5 * 60_000,
      now,
      now,
    );

    const healthy = getFeedHealth('feed-health', now);
    expect(healthy?.status).toBe('healthy');
    expect(healthy?.stale).toBe(false);
    expect(healthy?.ageMins).toBe(5);
    expect(healthy?.nextDueAt).toBe(now + 10 * 60_000);

    db.prepare('UPDATE feeds SET last_fetch_at = ? WHERE id = ?').run(
      now - 31 * 60_000,
      'feed-health',
    );
    const stale = getFeedHealth('feed-health', now);
    expect(stale?.status).toBe('stale');
    expect(stale?.stale).toBe(true);

    db.prepare(
      "UPDATE feeds SET last_fetch_status = 'error', error_count = 2, last_error = ? WHERE id = ?",
    ).run('HTTP error 503', 'feed-health');
    const errorState = getFeedHealth('feed-health', now);
    expect(errorState?.status).toBe('error');
    expect(errorState?.errorCount).toBe(2);
    expect(errorState?.lastError).toBe('HTTP error 503');
  });
});
