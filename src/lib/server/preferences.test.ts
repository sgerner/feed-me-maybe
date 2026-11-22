import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbHandle } from '#lib/server/db/test-db.ts';
import type { PreferenceMemoryDelta } from './preferences';

describe('preference learning model', () => {
  let testDb: TestDbHandle;

  beforeAll(() => {
    testDb = createTestDb('feed-me-maybe-preferences-');
  });

  afterAll(() => {
    testDb.cleanup();
  });

  it('learns negative obituary preference and can auto-hide future similar article', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
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
    const { getDb } = await import('#lib/server/db/index.ts');
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
    const { getDb } = await import('#lib/server/db/index.ts');
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
    const { getDb } = await import('#lib/server/db/index.ts');
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
        "INSERT OR REPLACE INTO article_ai_metadata (id, article_id, summary, topics, entities, content_type, ai_relevance_score, novelty_score, quality_score, likely_user_interest, signals, explanation, analysis_status, processed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)",
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
    const { getDb } = await import('#lib/server/db/index.ts');
    const { recordInteraction } = await import('#lib/server/interactions.ts');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
    ).run('hide_on_open', 'false', now);
    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'feed-feedback',
      'https://example.com/feedback',
      'Feedback Feed',
      now,
      now,
    );

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
    insertArticle(
      'a-thumb-up-feedback',
      'Thumb up feedback article',
      'Thumb Up Example',
    );
    insertArticle(
      'a-thumb-down-feedback',
      'Thumb down feedback article',
      'Thumb Down Example',
    );
    insertArticle(
      'a-boost-feedback',
      'Boost feedback article',
      'Boost Example',
    );

    recordInteraction('a-open-feedback', 'open');
    recordInteraction('a-hide-feedback', 'hide');
    recordInteraction('a-thumb-up-feedback', 'thumbs_up');
    recordInteraction('a-thumb-down-feedback', 'thumbs_down');
    recordInteraction('a-boost-feedback', 'boost');

    const rows = db
      .prepare(
        'SELECT type, label, polarity, strength FROM user_preference_memory WHERE label IN (?, ?, ?, ?, ?)',
      )
      .all(
        'author:open_example',
        'author:hide_example',
        'author:thumb_up_example',
        'author:thumb_down_example',
        'author:boost_example',
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
    const thumbsDownStrength = getStrength(
      'author:thumb_down_example',
      'negative',
    );
    const boostStrength = getStrength('author:boost_example', 'positive');

    expect(openStrength).toBeGreaterThan(0);
    expect(hideStrength).toBeGreaterThan(0);
    expect(openStrength).toBeLessThan(thumbsUpStrength);
    expect(hideStrength).toBeLessThan(thumbsDownStrength);
    expect(boostStrength).toBeGreaterThan(thumbsUpStrength);
  });

  it('uses peak decayed negative evidence, gates broad/quality features, normalizes symbols/authors, and reconciles auto-hides', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const {
      updatePreferenceMemoryFromInteraction,
      getPreferenceStateForArticle,
      applyPreferenceModelToArticle,
      reconcileAutoHiddenArticles,
    } = await import('./preferences');
    const { ARTICLE_ANALYSIS_CONTENT_TYPES } = await import('./ai/prompts');
    expect(ARTICLE_ANALYSIS_CONTENT_TYPES).toContain('obituary');

    const db = getDb();
    db.prepare('DELETE FROM user_preference_memory').run();
    db.prepare('DELETE FROM user_interactions').run();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-norm', 'https://example.com/norm.xml', 'Norm', now, now);

    const insertWithAi = (
      id: string,
      opts: {
        title: string;
        author: string;
        categories?: string[];
        topics?: string[];
        contentType?: string;
        signals?: string[];
      },
    ) => {
      db.prepare(
        'INSERT OR REPLACE INTO articles (id, feed_id, url, title, author, summary, categories, hidden, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 50, ?, ?, ?)',
      ).run(
        id,
        'feed-norm',
        `https://example.com/${id}`,
        opts.title,
        opts.author,
        'Plain summary.',
        JSON.stringify(opts.categories ?? []),
        now,
        now,
        now,
      );
      db.prepare(
        `INSERT OR REPLACE INTO article_ai_metadata
           (id, article_id, summary, topics, entities, content_type, ai_relevance_score, novelty_score, quality_score, likely_user_interest, signals, explanation, analysis_status, processed_at, created_at)
         VALUES (?, ?, ?, ?, '[]', ?, 0.5, 0.5, 0.5, 'medium', ?, '', 'ready', ?, ?)`,
      ).run(
        `meta-${id}`,
        id,
        'Plain summary.',
        JSON.stringify(opts.topics ?? []),
        opts.contentType ?? 'news',
        JSON.stringify(opts.signals ?? []),
        now,
        now,
      );
    };

    insertWithAi('norm-1', {
      title: 'Systems release notes for C++ and C#',
      author: 'By Alice <alice@ex.com>, Bob (bob@ex.com) & Carol and Dave; Eve',
      topics: ['C++', 'C#', 'F#', '.NET', 'Node.js', 'Café'],
      contentType: 'release_note',
      signals: ['primary_source', 'clickbait'],
    });
    insertWithAi('norm-2', {
      title: 'Unrelated generic update',
      author: 'Someone Else',
      topics: ['unrelated'],
      contentType: 'news',
      signals: ['primary_source', 'concrete_update'],
    });

    updatePreferenceMemoryFromInteraction('norm-1', 'thumbs_down');

    const memRows = db
      .prepare('SELECT type, label, polarity FROM user_preference_memory')
      .all() as Array<{ type: string; label: string; polarity: string }>;
    const negLabels = memRows
      .filter((r) => r.polarity === 'negative')
      .map((r) => r.label);
    expect(negLabels).toEqual(
      expect.arrayContaining([
        'topic:c_plus_plus',
        'topic:c_sharp',
        'topic:f_sharp',
        'topic:dotnet',
        'topic:nodejs',
        'topic:café',
        'content_type:release_note',
        'author:alice',
        'author:bob',
        'author:carol',
        'author:dave',
        'signal:clickbait',
      ]),
    );
    expect(negLabels).not.toContain('author:eve');
    expect(negLabels).not.toContain('signal:primary_source');

    // Positive vote must not reward negative quality signals or store news/other
    updatePreferenceMemoryFromInteraction('norm-1', 'thumbs_up');
    updatePreferenceMemoryFromInteraction('norm-2', 'thumbs_up');
    const allLabels = new Set(
      (
        db.prepare('SELECT label FROM user_preference_memory').all() as Array<{
          label: string;
        }>
      ).map((r) => r.label),
    );
    expect(allLabels).not.toContain('content_type:news');
    expect(allLabels).not.toContain('content_type:other');

    const posSignals = new Set(
      (
        db
          .prepare(
            "SELECT label FROM user_preference_memory WHERE polarity = 'positive' AND type = 'signal'",
          )
          .all() as Array<{ label: string }>
      ).map((r) => r.label),
    );
    expect(posSignals).toContain('signal:primary_source');
    expect(posSignals).not.toContain('signal:clickbait');

    // Correlated features from a single downvote stay below peak evidence threshold 2.5
    insertWithAi('single-down-target', {
      title: 'Systems release notes for C++ and C#',
      author: 'Alice',
      topics: ['C++', 'C#', 'F#'],
      contentType: 'release_note',
      signals: ['clickbait'],
    });
    const singleState = getPreferenceStateForArticle('single-down-target');
    expect(singleState.totalNegativeEvidence).toBeLessThanOrEqual(1);
    applyPreferenceModelToArticle('single-down-target');
    expect(
      db
        .prepare('SELECT hidden FROM articles WHERE id = ?')
        .get('single-down-target'),
    ).toEqual({ hidden: 0 });

    // Reconcile unhides model-auto-hidden article when memory decreases, keeping manual hide
    insertWithAi('auto-hidden-reconcile', {
      title: 'Obituary: Test',
      author: 'Writer',
      topics: ['reconcile_me'],
      contentType: 'obituary',
    });
    insertWithAi('manual-hidden-reconcile', {
      title: 'Manual hide test',
      author: 'Writer',
      topics: ['reconcile_me'],
      contentType: 'obituary',
    });
    db.prepare(
      'INSERT INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'pref-reconcile',
      'topic:reconcile_me',
      'topic',
      'negative',
      1.0,
      4,
      now,
      '',
      now,
    );
    db.prepare(
      'INSERT INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'pref-reconcile-obit',
      'negative_filter:obituary',
      'negative_filter',
      'negative',
      1.0,
      4,
      now,
      '',
      now,
    );
    db.prepare('UPDATE articles SET hidden = 1 WHERE id = ?').run(
      'auto-hidden-reconcile',
    );
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'auto-hide-evt',
      'auto-hidden-reconcile',
      'hide',
      now,
      '{"auto":true,"reason":"preference_model"}',
    );
    db.prepare('UPDATE articles SET hidden = 1 WHERE id = ?').run(
      'manual-hidden-reconcile',
    );
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run('manual-hide-evt', 'manual-hidden-reconcile', 'hide', now, '{}');

    expect(reconcileAutoHiddenArticles()).toBe(0);
    db.prepare(
      "DELETE FROM user_preference_memory WHERE id IN ('pref-reconcile', 'pref-reconcile-obit')",
    ).run();
    expect(reconcileAutoHiddenArticles()).toBe(1);
    expect(
      db
        .prepare('SELECT hidden FROM articles WHERE id = ?')
        .get('auto-hidden-reconcile'),
    ).toEqual({ hidden: 0 });
    expect(
      db
        .prepare('SELECT hidden FROM articles WHERE id = ?')
        .get('manual-hidden-reconcile'),
    ).toEqual({ hidden: 1 });
  });

  it('retains active preference rows on partial reversals after multiple boosts', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const {
      updatePreferenceMemoryFromInteraction,
      reversePreferenceMemoryDeltas,
      getDecayedStrength,
    } = await import('./preferences');
    const db = getDb();
    db.prepare('DELETE FROM user_preference_memory').run();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-clamp', 'https://example.com/clamp.xml', 'Clamp', now, now);

    for (const id of ['clamp-1', 'clamp-2', 'clamp-3']) {
      db.prepare(
        'INSERT OR REPLACE INTO articles (id, feed_id, url, title, author, categories, hidden, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 50, ?, ?, ?)',
      ).run(
        id,
        'feed-clamp',
        `https://example.com/${id}`,
        `Distributed Systems ${id}`,
        'Distributed Author',
        JSON.stringify(['Distributed']),
        now,
        now,
        now,
      );
    }

    const deltas1: PreferenceMemoryDelta[] = [];
    const deltas2: PreferenceMemoryDelta[] = [];
    const deltas3: PreferenceMemoryDelta[] = [];
    updatePreferenceMemoryFromInteraction('clamp-1', 'boost', deltas1);
    updatePreferenceMemoryFromInteraction('clamp-2', 'boost', deltas2);
    updatePreferenceMemoryFromInteraction('clamp-3', 'boost', deltas3);

    reversePreferenceMemoryDeltas(deltas1, now);
    reversePreferenceMemoryDeltas(deltas2, now);

    const remaining = db
      .prepare(
        "SELECT strength, evidence_count, last_reinforced FROM user_preference_memory WHERE label = 'topic:distributed' AND polarity = 'positive'",
      )
      .get() as
      | { strength: number; evidence_count: number; last_reinforced: number }
      | undefined;

    expect(remaining).toBeDefined();
    expect(remaining!.evidence_count).toBe(1);
    expect(
      getDecayedStrength(remaining!.strength, remaining!.last_reinforced),
    ).toBeCloseTo(0.45 * 1.1, 3);
  });
});
