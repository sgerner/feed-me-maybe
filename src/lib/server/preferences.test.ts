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
    const {
      updatePreferenceMemoryFromInteraction,
      applyPreferenceModelToArticle,
    } = await import('./preferences');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-obits', 'https://www.nytimes.com/rss', 'NYT', now, now);
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, summary, categories, hidden, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
      now,
    );
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, summary, categories, hidden, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
      now,
    );

    updatePreferenceMemoryFromInteraction('a-train', 'hide');
    updatePreferenceMemoryFromInteraction('a-train', 'thumbs_down');
    updatePreferenceMemoryFromInteraction('a-train', 'hide');

    applyPreferenceModelToArticle('a-future');

    const future = db
      .prepare('SELECT hidden, heuristic_score FROM articles WHERE id = ?')
      .get('a-future') as {
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
      'INSERT OR REPLACE INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'stale-pref',
      'topic:obituaries',
      'topic',
      'negative',
      1,
      1,
      stale,
      '',
      stale,
    );
    db.prepare(
      'INSERT OR REPLACE INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'fresh-pref',
      'topic:obituaries',
      'topic',
      'negative',
      1,
      1,
      now,
      '',
      now,
    );

    const feedExists = db
      .prepare('SELECT id FROM feeds WHERE id = ?')
      .get('feed-decay') as { id: string } | undefined;
    if (!feedExists) {
      db.prepare(
        'INSERT INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('feed-decay', 'https://example.com/decay', 'Decay Feed', now, now);
    }
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, categories, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'a-decay',
      'feed-decay',
      'https://example.com/decay/a',
      'Obituaries roundup',
      JSON.stringify(['Obituaries']),
      50,
      now,
      now,
      now,
    );

    const state = getPreferenceStateForArticle('a-decay');
    expect(state.adjustment).toBeLessThan(0);
    expect(state.adjustment).toBeGreaterThan(-25);
  });

  it('matches phrases in different orders', async () => {
    const { getDb } = await import('$lib/server/db');
    const {
      updatePreferenceMemoryFromInteraction,
      getPreferenceStateForArticle,
    } = await import('./preferences');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-phrase', 'https://example.com/phrase', 'Phrase Feed', now, now);

    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'a-phrase-1',
      'feed-phrase',
      'https://example.com/p1',
      'Open Source Software',
      50,
      now,
      now,
      now,
    );

    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'a-phrase-2',
      'feed-phrase',
      'https://example.com/p2',
      'Software Open Source',
      50,
      now,
      now,
      now,
    );

    updatePreferenceMemoryFromInteraction('a-phrase-1', 'thumbs_up');

    const state = getPreferenceStateForArticle('a-phrase-2');
    expect(state.adjustment).toBeGreaterThan(0);
  });

  it('learns neutral signal and author preferences from article feedback', async () => {
    const { getDb } = await import('$lib/server/db');
    const {
      updatePreferenceMemoryFromInteraction,
      getPreferenceStateForArticle,
      applyPreferenceModelToArticle,
    } = await import('./preferences');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-signal', 'https://example.com/rss', 'Example', now, now);

    const insertArticle = (id: string, slug: string) => {
      db.prepare(
        'INSERT OR REPLACE INTO articles (id, feed_id, url, title, author, categories, hidden, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        'feed-signal',
        `https://example.com/articles/${slug}`,
        slug,
        'Jane Doe',
        JSON.stringify(['AI']),
        0,
        50,
        now,
        now,
        now,
      );
    };

    const insertMetadata = (articleId: string) => {
      db.prepare(
        'INSERT OR REPLACE INTO article_ai_metadata (id, article_id, summary, topics, entities, content_type, ai_relevance_score, novelty_score, quality_score, likely_user_interest, signals, explanation, processed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        `meta-${articleId}`,
        articleId,
        'Speculation about Gemini future models.',
        JSON.stringify(['Gemini']),
        JSON.stringify(['Gemini']),
        'news',
        0.6,
        0.3,
        0.2,
        'low',
        JSON.stringify(['specific_details', 'speculation', 'future_guessing']),
        '',
        now,
        now,
      );
    };

    insertArticle('a-signal-1', 'speculation');
    insertArticle('a-signal-2', 'update');
    insertMetadata('a-signal-1');
    insertMetadata('a-signal-2');

    updatePreferenceMemoryFromInteraction('a-signal-1', 'thumbs_down');

    const rows = db
      .prepare(
        'SELECT type, label, polarity FROM user_preference_memory WHERE label IN (?, ?)',
      )
      .all('signal:speculation', 'author:jane_doe') as Array<{
      type: string;
      label: string;
      polarity: string;
    }>;

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'signal',
          label: 'signal:speculation',
          polarity: 'negative',
        }),
        expect.objectContaining({
          type: 'author',
          label: 'author:jane_doe',
          polarity: 'negative',
        }),
      ]),
    );

    const state = getPreferenceStateForArticle('a-signal-2');
    expect(state.adjustment).toBeLessThan(0);

    applyPreferenceModelToArticle('a-signal-2');
    const future = db
      .prepare('SELECT heuristic_score FROM articles WHERE id = ?')
      .get('a-signal-2') as { heuristic_score: number };
    expect(future.heuristic_score).toBeLessThan(50);
  });

  it('treats open and manual hide as weaker feedback than thumbs', async () => {
    const { getDb } = await import('$lib/server/db');
    const { recordInteraction } = await import('$lib/server/interactions');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
    ).run('hide_on_open', 'false', now);
    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-feedback', 'https://example.com/feedback', 'Feedback Feed', now, now);

    const insertArticle = (id: string, title: string, author: string) => {
      db.prepare(
        'INSERT OR REPLACE INTO articles (id, feed_id, url, title, author, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        'feed-feedback',
        `https://example.com/articles/${id}`,
        title,
        author,
        50,
        now,
        now,
        now,
      );
    };

    insertArticle('a-open-feedback', 'Open feedback article', 'Open Example');
    insertArticle('a-hide-feedback', 'Hide feedback article', 'Hide Example');
    insertArticle('a-thumb-up-feedback', 'Thumb up feedback article', 'Thumb Up Example');
    insertArticle('a-thumb-down-feedback', 'Thumb down feedback article', 'Thumb Down Example');

    recordInteraction('a-open-feedback', 'open');
    recordInteraction('a-hide-feedback', 'hide');
    recordInteraction('a-thumb-up-feedback', 'thumbs_up');
    recordInteraction('a-thumb-down-feedback', 'thumbs_down');

    const rows = db
      .prepare(
        'SELECT type, label, polarity, strength FROM user_preference_memory WHERE label IN (?, ?, ?, ?)',
      )
      .all(
        'author:open_example',
        'author:hide_example',
        'author:thumb_up_example',
        'author:thumb_down_example',
      ) as Array<{
      type: string;
      label: string;
      polarity: string;
      strength: number;
    }>;

    const getStrength = (label: string, polarity: 'positive' | 'negative') =>
      rows.find((row) => row.label === label && row.polarity === polarity)
        ?.strength || 0;

    const openStrength = getStrength('author:open_example', 'positive');
    const hideStrength = getStrength('author:hide_example', 'negative');
    const thumbsUpStrength = getStrength('author:thumb_up_example', 'positive');
    const thumbsDownStrength = getStrength('author:thumb_down_example', 'negative');

    expect(openStrength).toBeGreaterThan(0);
    expect(hideStrength).toBeGreaterThan(0);
    expect(openStrength).toBeLessThan(thumbsUpStrength);
    expect(hideStrength).toBeLessThan(thumbsDownStrength);
  });
});
