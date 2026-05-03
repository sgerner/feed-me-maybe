import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

describe('preference learning model', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-preferences.db');
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

  it('learns negative obituary preference and can auto-hide future similar article', async () => {
    const { getDb } = await import('$lib/server/db');
    const { updatePreferenceMemoryFromInteraction, applyPreferenceModelToArticle } = await import('./preferences');
    const db = getDb();
    const now = Date.now();

    db.prepare('INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      'feed-obits',
      'https://www.nytimes.com/rss',
      'NYT',
      now,
      now
    );
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, summary, categories, hidden, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'a-train',
      'feed-obits',
      'https://www.nytimes.com/a-train',
      'Obituary: Notable Figure Dies at 87',
      'An obituary and remembrance article.',
      JSON.stringify(['Obituaries']),
      0,
      50,
      now,
      now,
      now
    );
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, summary, categories, hidden, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'a-future',
      'feed-obits',
      'https://www.nytimes.com/a-future',
      'In Memoriam: Community Leader',
      'Obituary coverage for community leader.',
      JSON.stringify(['Obituaries']),
      0,
      50,
      now,
      now,
      now
    );

    updatePreferenceMemoryFromInteraction('a-train', 'hide');
    updatePreferenceMemoryFromInteraction('a-train', 'thumbs_down');
    updatePreferenceMemoryFromInteraction('a-train', 'hide');

    applyPreferenceModelToArticle('a-future');

    const future = db.prepare('SELECT hidden, heuristic_score FROM articles WHERE id = ?').get('a-future') as {
      hidden: number;
      heuristic_score: number;
    };
    expect(future.heuristic_score).toBeLessThan(40);
    expect(future.hidden).toBe(1);
  });

  it('decays stale preferences when scoring', async () => {
    const { getDb } = await import('$lib/server/db');
    const { getPreferenceStateForArticle } = await import('./preferences');
    const db = getDb();
    const now = Date.now();
    const stale = now - 180 * 24 * 60 * 60 * 1000;

    db.prepare(
      'INSERT OR REPLACE INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('stale-pref', 'topic:obituaries', 'topic', 'negative', 1, 1, stale, '', stale);
    db.prepare(
      'INSERT OR REPLACE INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('fresh-pref', 'topic:obituaries', 'topic', 'negative', 1, 1, now, '', now);

    const feedExists = db.prepare('SELECT id FROM feeds WHERE id = ?').get('feed-decay') as { id: string } | undefined;
    if (!feedExists) {
      db.prepare('INSERT INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        'feed-decay',
        'https://example.com/decay',
        'Decay Feed',
        now,
        now
      );
    }
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, categories, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'a-decay',
      'feed-decay',
      'https://example.com/decay/a',
      'Obituaries roundup',
      JSON.stringify(['Obituaries']),
      50,
      now,
      now,
      now
    );

    const state = getPreferenceStateForArticle('a-decay');
    expect(state.adjustment).toBeLessThan(0);
    expect(state.adjustment).toBeGreaterThan(-25);
  });
});
