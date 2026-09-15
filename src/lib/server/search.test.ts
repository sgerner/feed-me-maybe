import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

describe('personal search engine', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-personal-search.db');
  const originalDbUrl = process.env.DATABASE_URL;
  let now = Date.now();

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
    db.prepare('DELETE FROM articles').run();
    db.prepare('DELETE FROM feeds').run();
    now = Date.now();
    const insertFeed = db.prepare(
      'INSERT INTO feeds (id, url, title, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertFeed.run(
      'feed-science',
      'https://example.com/science.xml',
      'Science Feed',
      'science',
      now,
      now,
    );
    insertFeed.run(
      'feed-world',
      'https://example.com/world.xml',
      'World Feed',
      'world',
      now,
      now,
    );

    const insertArticle = db.prepare(
      `INSERT INTO articles
        (id, feed_id, url, title, author, summary, content, categories,
         published_at, fetched_at, read, saved, hidden, thumbs_down,
         heuristic_score, combined_score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertArticle.run(
      'article-quantum',
      'feed-science',
      'https://example.com/quantum',
      'Quantum computing breakthrough',
      'Ada Lovelace',
      'A quantum processor made a useful advance.',
      'Researchers explain the quantum error correction result.',
      '["research"]',
      now - 1_000,
      now - 1_000,
      0,
      1,
      0,
      0,
      80,
      80,
      now,
      now,
    );
    insertArticle.run(
      'article-climate',
      'feed-science',
      'https://example.com/climate',
      'Climate data archive expands',
      'Grace Hopper',
      'A new archive helps scientists compare climate data.',
      'The climate research archive is open to the public.',
      '["environment"]',
      now - 2_000,
      now - 2_000,
      1,
      0,
      0,
      0,
      70,
      70,
      now,
      now,
    );
    insertArticle.run(
      'article-hidden',
      'feed-world',
      'https://example.com/hidden',
      'Hidden quantum analysis',
      'Alan Turing',
      'An older analysis of quantum systems.',
      'Full hidden content about quantum systems.',
      '["analysis"]',
      now - 3_000,
      now - 3_000,
      0,
      0,
      1,
      0,
      60,
      60,
      now,
      now,
    );
    insertArticle.run(
      'article-rejected',
      'feed-world',
      'https://example.com/rejected',
      'Rejected quantum story',
      'Katherine Johnson',
      'Not a story to keep.',
      'Rejected quantum content.',
      '["opinion"]',
      now - 4_000,
      now - 4_000,
      0,
      0,
      1,
      1,
      10,
      10,
      now,
      now,
    );
  });

  afterAll(async () => {
    const { closeDb } = await import('$lib/server/db');
    closeDb();
    process.env.DATABASE_URL = originalDbUrl ?? '';
    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${testDbPath}${suffix}`;
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it('indexes article fields and returns highlighted matches', async () => {
    const { searchArticles } = await import('./search');
    const result = searchArticles({ query: 'quantum', sort: 'relevance' });

    expect(result.total).toBe(3);
    expect(result.articles.map((article) => article.id)).toEqual(
      expect.arrayContaining([
        'article-quantum',
        'article-hidden',
        'article-rejected',
      ]),
    );
    expect(result.articles[0]?.titleHighlight).toContain(
      '<mark>quantum</mark>',
    );
    expect(result.articles[0]?.contentHighlight).toContain(
      '<mark>quantum</mark>',
    );
  });

  it('supports safe feed, category, date, and state operators', async () => {
    const { searchArticles, parseSearchQuery, SearchQueryError } =
      await import('./search');
    const result = searchArticles({
      query:
        'quantum feed:"World Feed" category:world after:2020-01-01 is:hidden is:rejected',
      sort: 'relevance',
    });

    expect(result.total).toBe(1);
    expect(result.articles[0]?.id).toBe('article-rejected');
    expect(parseSearchQuery('is:unread').filters.unread).toBe(true);
    expect(() => parseSearchQuery('before:not-a-date')).toThrow(
      SearchQueryError,
    );
    expect(() => parseSearchQuery('is:drop-table')).toThrow(SearchQueryError);
  });

  it('keeps recent cursor pagination stable and updates the FTS trigger index', async () => {
    const { getDb } = await import('$lib/server/db');
    const { searchArticles } = await import('./search');
    const first = searchArticles({ limit: 1, sort: 'recent' });
    expect(first.articles).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();

    const second = searchArticles({
      limit: 10,
      sort: 'recent',
      cursor: first.nextCursor!,
    });
    expect(second.articles.map((article) => article.id)).not.toContain(
      first.articles[0]?.id,
    );
    expect(
      new Set(
        [...first.articles, ...second.articles].map((article) => article.id),
      ).size,
    ).toBe(4);

    getDb()
      .prepare('UPDATE articles SET title = ?, content = ? WHERE id = ?')
      .run(
        'New astronomy report',
        'Astronomy and orbital mechanics.',
        'article-climate',
      );
    const updated = searchArticles({ query: 'astronomy', sort: 'relevance' });
    expect(updated.articles.map((article) => article.id)).toEqual([
      'article-climate',
    ]);
  });

  it('keeps relevance cursor pagination stable across tied scores', async () => {
    const { searchArticles } = await import('./search');
    const first = searchArticles({
      query: 'quantum',
      limit: 1,
      sort: 'relevance',
    });
    expect(first.nextCursor).toBeTruthy();
    const second = searchArticles({
      query: 'quantum',
      limit: 10,
      sort: 'relevance',
      cursor: first.nextCursor!,
    });

    expect(second.articles.map((article) => article.id)).not.toContain(
      first.articles[0]?.id,
    );
    expect(
      new Set(
        [...first.articles, ...second.articles].map((article) => article.id),
      ).size,
    ).toBe(3);
  });

  it('runs the versioned migration idempotently', async () => {
    const { getDb } = await import('$lib/server/db');
    const { initializeDatabase } = await import('$lib/server/db/migrate');
    initializeDatabase();
    initializeDatabase();
    const migration = getDb()
      .prepare('SELECT version, name FROM schema_migrations WHERE version = 1')
      .get() as { version: number; name: string };
    expect(migration).toEqual({
      version: 1,
      name: 'article_state_search_foundation',
    });
    expect(
      (
        getDb()
          .prepare('SELECT COUNT(*) AS count FROM article_search')
          .get() as { count: number }
      ).count,
    ).toBe(4);
  });
});
