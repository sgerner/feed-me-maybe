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
    const { initializeDatabase } = await import('#lib/server/db/migrate.ts');
    initializeDatabase();
  });

  afterAll(async () => {
    const { closeDb } = await import('#lib/server/db/index.ts');
    closeDb();
    process.env.DATABASE_URL = originalDbUrl ?? '';
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
  });

  it('hides an article when it is thumbed down', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
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
      .prepare(
        'SELECT hidden, thumbs_up, thumbs_down FROM articles WHERE id = ?',
      )
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

  it('restores and strongly boosts an auto-hidden article', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { recordInteraction } = await import('./interactions');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-boost', 'https://example.com/rss', 'Example Boost', now, now);
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, hidden, thumbs_up, thumbs_down, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'article-boost',
      'feed-boost',
      'https://example.com/articles/boost',
      'Boosted Article',
      1,
      0,
      1,
      now,
      now,
      now,
    );

    recordInteraction('article-boost', 'boost');

    const article = db
      .prepare(
        'SELECT hidden, thumbs_up, thumbs_down FROM articles WHERE id = ?',
      )
      .get('article-boost') as {
      hidden: number;
      thumbs_up: number;
      thumbs_down: number;
    };
    const interaction = db
      .prepare(
        'SELECT interaction_type FROM user_interactions WHERE article_id = ? ORDER BY timestamp DESC LIMIT 1',
      )
      .get('article-boost') as { interaction_type: string };

    expect(article.hidden).toBe(0);
    expect(article.thumbs_up).toBe(1);
    expect(article.thumbs_down).toBe(0);
    expect(interaction.interaction_type).toBe('boost');
  });

  it('learns from an article open only once even when the reader reloads it', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { recordInteraction } = await import('./interactions');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
    ).run('hide_on_open', 'false', now);
    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'feed-duplicate-open',
      'https://example.com/duplicate.xml',
      'Duplicate Open Feed',
      now,
      now,
    );
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, author, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'article-duplicate-open',
      'feed-duplicate-open',
      'https://example.com/duplicate-open',
      'Repeated open article',
      'Repeated Open Author',
      now,
      now,
      now,
    );

    recordInteraction('article-duplicate-open', 'open');
    recordInteraction('article-duplicate-open', 'unread');
    const scoreAfterUnread = (
      db
        .prepare('SELECT heuristic_score FROM articles WHERE id = ?')
        .get('article-duplicate-open') as { heuristic_score: number }
    ).heuristic_score;
    recordInteraction('article-duplicate-open', 'open');

    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM user_interactions WHERE article_id = ? AND interaction_type = 'open'",
        )
        .get('article-duplicate-open'),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT evidence_count FROM user_preference_memory WHERE label = 'author:repeated_open_author' AND polarity = 'positive'",
        )
        .get(),
    ).toEqual({ evidence_count: 1 });
    const article = db
      .prepare('SELECT read, heuristic_score FROM articles WHERE id = ?')
      .get('article-duplicate-open') as {
      read: number;
      heuristic_score: number;
    };
    expect(article.read).toBe(1);
    expect(article.heuristic_score).toBeGreaterThan(scoreAfterUnread);
  });

  it('records hide-on-open as automatic state, not repeated negative interaction', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { recordInteraction } = await import('./interactions');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
    ).run('hide_on_open', 'true', now);
    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'feed-auto-hide',
      'https://example.com/auto-hide.xml',
      'Auto Hide Feed',
      now,
      now,
    );
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'article-auto-hide',
      'feed-auto-hide',
      'https://example.com/auto-hide',
      'Automatically hidden article',
      now,
      now,
      now,
    );

    recordInteraction('article-auto-hide', 'open');
    recordInteraction('article-auto-hide', 'open');

    expect(
      db
        .prepare('SELECT hidden FROM articles WHERE id = ?')
        .get('article-auto-hide'),
    ).toEqual({ hidden: 1 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM user_interactions WHERE article_id = ? AND interaction_type = 'hide' AND json_extract(metadata, '$.auto') = 1",
        )
        .get('article-auto-hide'),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM user_preference_memory WHERE label LIKE 'author:%' AND polarity = 'negative'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it('records an unchanged like or dislike only once', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { recordInteraction } = await import('./interactions');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'feed-repeated-reaction',
      'https://example.com/reactions.xml',
      'Reactions',
      now,
      now,
    );
    const insertArticle = db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, author, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertArticle.run(
      'article-repeated-like',
      'feed-repeated-reaction',
      'https://example.com/repeated-like',
      'Repeated like',
      'Like Author',
      now,
      now,
      now,
    );
    insertArticle.run(
      'article-repeated-dislike',
      'feed-repeated-reaction',
      'https://example.com/repeated-dislike',
      'Repeated dislike',
      'Dislike Author',
      now,
      now,
      now,
    );

    recordInteraction('article-repeated-like', 'thumbs_up');
    recordInteraction('article-repeated-like', 'thumbs_up');
    recordInteraction('article-repeated-dislike', 'thumbs_down');
    recordInteraction('article-repeated-dislike', 'thumbs_down');

    expect(
      db
        .prepare(
          "SELECT article_id, interaction_type, COUNT(*) AS count FROM user_interactions WHERE article_id IN ('article-repeated-like', 'article-repeated-dislike') GROUP BY article_id, interaction_type ORDER BY article_id",
        )
        .all(),
    ).toEqual([
      {
        article_id: 'article-repeated-dislike',
        interaction_type: 'thumbs_down',
        count: 1,
      },
      {
        article_id: 'article-repeated-like',
        interaction_type: 'thumbs_up',
        count: 1,
      },
    ]);
    expect(
      db
        .prepare(
          "SELECT label, polarity, evidence_count FROM user_preference_memory WHERE label IN ('author:like_author', 'author:dislike_author') ORDER BY label",
        )
        .all(),
    ).toEqual([
      {
        label: 'author:dislike_author',
        polarity: 'negative',
        evidence_count: 1,
      },
      { label: 'author:like_author', polarity: 'positive', evidence_count: 1 },
    ]);
  });

  it('guards repeat boost, supports unthumbs_up, bumps state_version, and reflects hide_on_open in article load', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { recordInteraction } = await import('./interactions');
    const { load } = await import('../../routes/articles/[id]/+page.server');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
    ).run('hide_on_open', 'true', now);
    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-load', 'https://example.com/load.xml', 'Load Feed', now, now);
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, author, state_version, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
    ).run(
      'article-load-1',
      'feed-load',
      'https://example.com/load-1',
      'Load Article',
      'Load Author',
      now,
      now,
      now,
    );

    const loaded = (await load({
      params: { id: 'article-load-1' },
      locals: { sessionId: 'sess' },
      url: new URL('http://localhost/articles/article-load-1'),
    } as never)) as {
      article: { hidden: number; read: number; state_version: number };
    };
    expect(loaded.article.read).toBe(1);
    expect(loaded.article.hidden).toBe(1);
    expect(loaded.article.state_version).toBeGreaterThan(0);

    recordInteraction('article-load-1', 'boost');
    recordInteraction('article-load-1', 'boost');
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM user_interactions WHERE article_id = 'article-load-1' AND interaction_type = 'boost'",
        )
        .get(),
    ).toEqual({ c: 1 });
    expect(
      db
        .prepare(
          "SELECT evidence_count FROM user_preference_memory WHERE label = 'author:load_author'",
        )
        .get(),
    ).toEqual({ evidence_count: 2 });

    recordInteraction('article-load-1', 'unthumbs_up');
    expect(
      db
        .prepare('SELECT thumbs_up FROM articles WHERE id = ?')
        .get('article-load-1'),
    ).toEqual({ thumbs_up: 0 });
    expect(
      db
        .prepare(
          "SELECT evidence_count FROM user_preference_memory WHERE label = 'author:load_author'",
        )
        .get(),
    ).toEqual({ evidence_count: 1 });
  });
});
