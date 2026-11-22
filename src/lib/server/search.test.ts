import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbHandle } from '#lib/server/db/test-db.ts';

describe('personal search engine', () => {
  let testDb: TestDbHandle;
  let now = Date.now();

  beforeAll(() => {
    testDb = createTestDb('feed-me-maybe-search-');
  });

  beforeEach(() => {
    testDb.reset();
    const db = testDb.db;
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

  afterAll(() => {
    testDb.cleanup();
  });

  it('indexes article fields and returns highlighted matches', async () => {
    const { searchArticles } = await import('./search');
    const result = searchArticles({ query: 'quantum', sort: 'relevance' });

    expect(result.total).toBe(1);
    expect(result.articles.map((article) => article.id)).toEqual([
      'article-quantum',
    ]);
    expect(result.articles[0]?.titleHighlight?.toLowerCase()).toContain(
      '<mark>quantum</mark>',
    );
    expect(result.articles[0]?.contentHighlight).toContain(
      '<mark>quantum</mark>',
    );
  });

  it('exposes hidden and rejected articles only through explicit state filters', async () => {
    const { searchArticles } = await import('./search');
    const hidden = searchArticles({
      query: 'quantum is:hidden',
      sort: 'relevance',
    });
    const rejected = searchArticles({
      query: 'quantum is:rejected',
      sort: 'relevance',
    });

    expect(hidden.articles.map((article) => article.id)).toEqual(
      expect.arrayContaining(['article-hidden', 'article-rejected']),
    );
    expect(rejected.articles.map((article) => article.id)).toEqual([
      'article-rejected',
    ]);
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
    const { getDb } = await import('#lib/server/db/index.ts');
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
    ).toBe(2);

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
      query: 'quantum is:hidden',
      limit: 1,
      sort: 'relevance',
    });
    expect(first.nextCursor).toBeTruthy();
    const second = searchArticles({
      query: 'quantum is:hidden',
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
    ).toBe(2);
  });

  it('runs the versioned migration idempotently', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { initializeDatabase } = await import('#lib/server/db/migrate.ts');
    initializeDatabase();
    initializeDatabase();
    const migration = getDb()
      .prepare('SELECT version, name FROM schema_migrations WHERE version = 1')
      .get() as { version: number; name: string };
    expect(migration).toEqual({
      version: 1,
      name: 'article_state_search_foundation',
    });
    const migration11 = getDb()
      .prepare('SELECT version, name FROM schema_migrations WHERE version = 11')
      .get() as { version: number; name: string };
    expect(migration11).toEqual({
      version: 11,
      name: 'strip_html_fts_index_and_triggers',
    });
    expect(
      (
        getDb()
          .prepare('SELECT COUNT(*) AS count FROM article_search')
          .get() as { count: number }
      ).count,
    ).toBe(4);
  });

  it('returns matched-only body snippets, strips HTML attributes, preserves title-only Markdown fallbacks, and falls back to recent sort without positive FTS terms', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { initializeDatabase } = await import('#lib/server/db/migrate.ts');
    const { formatContent } = await import('#lib/utils/format.ts');
    const { searchArticles, SearchQueryError } = await import('./search');
    const db = getDb();

    // 1. Body-only match + HTML attribute/script stripping
    db.prepare(
      `INSERT INTO articles
        (id, feed_id, url, title, author, summary, content, categories,
         published_at, fetched_at, read, saved, hidden, thumbs_down,
         heuristic_score, combined_score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'article-body-only',
      'feed-science',
      'https://example.com/body-only',
      'Weekly laboratory digest',
      'Niels Bohr',
      '<p class="decoyattr" data-topic="decoyattr">General overview without the target keyword.</p>',
      '<article data-attr="decoyattr"><p>Deep inside the body we examine <a href="https://example.com/decoyattr">superconducting</a> resonators &amp; cryogenics.</p><script>const decoyscript = true;</script></article>',
      '["physics"]',
      now - 500,
      now - 500,
      0,
      0,
      0,
      0,
      75,
      75,
      now,
      now,
    );

    expect(
      searchArticles({ query: 'decoyattr', sort: 'relevance' }).articles,
    ).toHaveLength(0);
    expect(
      searchArticles({ query: 'decoyscript', sort: 'relevance' }).articles,
    ).toHaveLength(0);

    const bodyMatch = searchArticles({
      query: 'superconducting',
      sort: 'relevance',
    });
    expect(bodyMatch.sort).toBe('relevance');
    expect(bodyMatch.articles.map((a) => a.id)).toEqual(['article-body-only']);
    expect(bodyMatch.articles[0]?.titleHighlight).toBeNull();
    expect(bodyMatch.articles[0]?.summaryHighlight).toBeNull();
    expect(bodyMatch.articles[0]?.contentHighlight).toContain(
      '<mark>superconducting</mark>',
    );
    expect(bodyMatch.articles[0]?.contentHighlight).toContain('&amp;');
    expect(bodyMatch.articles[0]?.contentHighlight).not.toMatch(
      /<article|<p|<a|decoyattr/i,
    );

    // Verify migration 11 backfill cleans pre-existing raw HTML in article_search
    const bodyRowid = (
      db
        .prepare('SELECT rowid FROM articles WHERE id = ?')
        .get('article-body-only') as { rowid: number }
    ).rowid;
    db.prepare('DELETE FROM article_search WHERE rowid = ?').run(bodyRowid);
    db.prepare(
      `INSERT INTO article_search(rowid, article_id, title, author, summary, content, feed_title, category)
       VALUES (?, 'article-body-only', 'Weekly laboratory digest', 'Niels Bohr', '<p class="legacyattr">Overview</p>', '<div data-legacy="legacyattr">Plain body</div>', 'Science Feed', 'science')`,
    ).run(bodyRowid);
    expect(
      searchArticles({ query: 'legacyattr', sort: 'relevance' }).articles,
    ).toHaveLength(1);

    db.prepare('DELETE FROM schema_migrations WHERE version = 11').run();
    initializeDatabase();
    expect(
      searchArticles({ query: 'legacyattr', sort: 'relevance' }).articles,
    ).toHaveLength(0);

    // 2. Title-only match keeps summaryHighlight and contentHighlight null for Markdown fallback + escapes HTML in titleHighlight
    const markdownSummary =
      '**Bold** summary with `inline code` and no title keyword.';
    db.prepare(
      `INSERT INTO articles
        (id, feed_id, url, title, author, summary, content, categories,
         published_at, fetched_at, read, saved, hidden, thumbs_down,
         heuristic_score, combined_score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'article-title-markdown',
      'feed-science',
      'https://example.com/title-md',
      'Photonic <chip> architecture',
      'Emmy Noether',
      markdownSummary,
      'Detailed optical waveguide notes.',
      '["hardware"]',
      now - 250,
      now - 250,
      0,
      0,
      0,
      0,
      85,
      85,
      now,
      now,
    );

    const titleOnly = searchArticles({ query: 'Photonic', sort: 'relevance' });
    expect(titleOnly.articles.map((a) => a.id)).toEqual([
      'article-title-markdown',
    ]);
    expect(titleOnly.articles[0]?.titleHighlight).toBe(
      '<mark>Photonic</mark> &lt;chip&gt; architecture',
    );
    expect(titleOnly.articles[0]?.summaryHighlight).toBeNull();
    expect(titleOnly.articles[0]?.contentHighlight).toBeNull();
    expect(formatContent(titleOnly.articles[0]?.summary)).toContain(
      '<strong>Bold</strong>',
    );

    // 3. Filter-only, empty, and standalone negation queries fall back to recent sort without throwing on sort=relevance
    const filterOnly = searchArticles({
      query: 'is:unread',
      sort: 'relevance',
      limit: 2,
    });
    expect(filterOnly.sort).toBe('recent');
    expect(filterOnly.articles.map((a) => a.id)).toEqual([
      'article-title-markdown',
      'article-body-only',
    ]);
    expect(filterOnly.nextCursor).toBeTruthy();

    const filterOnlyNextPage = searchArticles({
      query: 'is:unread',
      sort: 'relevance',
      cursor: filterOnly.nextCursor!,
    });
    expect(filterOnlyNextPage.sort).toBe('recent');
    expect(filterOnlyNextPage.articles.map((a) => a.id)).toEqual([
      'article-quantum',
    ]);

    const emptyQueryRelevance = searchArticles({
      query: '',
      sort: 'relevance',
    });
    expect(emptyQueryRelevance.sort).toBe('recent');

    const negationRelevance = searchArticles({
      query: '-quantum',
      sort: 'relevance',
    });
    expect(negationRelevance.sort).toBe('recent');

    expect(() =>
      searchArticles({ query: 'quantum', sort: 'invalid' as never }),
    ).toThrow(SearchQueryError);
  });

  it('excludes paused feeds from default searches while allowing explicit feed or state filters', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { searchArticles } = await import('./search');
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, title, category, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    ).run(
      'feed-paused-search',
      'https://paused.example.com/rss',
      'Paused Search Feed',
      'world',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO articles (id, feed_id, url, title, summary, content, read, saved, hidden, rejected, thumbs_down, fetched_at, created_at, updated_at)
       VALUES ('paused-quantum', 'feed-paused-search', 'https://paused.example.com/q', 'Paused quantum article', 'Quantum paused summary', 'Quantum paused content', 0, 1, 0, 0, 0, ?, ?, ?)`,
    ).run(now, now, now);

    const defaultResult = searchArticles({
      query: 'quantum is:unread category:world',
      sort: 'recent',
    });
    expect(defaultResult.articles.map((a) => a.id)).not.toContain(
      'paused-quantum',
    );

    const savedResult = searchArticles({
      query: 'quantum is:saved',
      sort: 'recent',
    });
    expect(savedResult.articles.map((a) => a.id)).toContain('paused-quantum');

    const explicitFeedResult = searchArticles({
      query: 'quantum feed:"Paused Search Feed"',
      sort: 'recent',
    });
    expect(explicitFeedResult.articles.map((a) => a.id)).toContain(
      'paused-quantum',
    );
  });

  it('supports quoted phrases, boolean OR, term exclusions, item categories, and hidden saved bookmarks', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { searchArticles, parseSearchQuery } = await import('./search');
    const db = getDb();

    // Quoted exact phrase matches adjacent words in order, not reversed order
    expect(parseSearchQuery('"quantum computing"').text).toBe(
      '"quantum computing"',
    );
    const exactMatch = searchArticles({
      query: '"quantum computing"',
      sort: 'relevance',
    });
    expect(exactMatch.articles.map((a) => a.id)).toEqual(['article-quantum']);

    const reversedMismatch = searchArticles({
      query: '"computing quantum"',
      sort: 'relevance',
    });
    expect(reversedMismatch.articles).toHaveLength(0);

    // Bare boolean OR matches either side
    expect(parseSearchQuery('quantum OR climate').text).toBe(
      '"quantum" OR "climate"',
    );
    const orResult = searchArticles({
      query: 'quantum OR climate',
      sort: 'recent',
    });
    expect(orResult.articles.map((a) => a.id)).toEqual([
      'article-quantum',
      'article-climate',
    ]);

    // Exclusion with -term and NOT term
    const excludedFromOr = searchArticles({
      query: 'quantum OR climate -climate',
      sort: 'recent',
    });
    expect(excludedFromOr.articles.map((a) => a.id)).toEqual([
      'article-quantum',
    ]);

    const notKeywordResult = searchArticles({
      query: 'quantum OR climate NOT quantum',
      sort: 'recent',
    });
    expect(notKeywordResult.articles.map((a) => a.id)).toEqual([
      'article-climate',
    ]);

    // Standalone -term exclusion works without invalid FTS5 syntax
    const standaloneNegative = searchArticles({
      query: '-quantum',
      sort: 'recent',
    });
    expect(standaloneNegative.articles.map((a) => a.id)).toEqual([
      'article-climate',
    ]);

    // Multi-is: composition (is:unread is:saved)
    const unreadSaved = searchArticles({
      query: 'is:unread is:saved',
      sort: 'recent',
    });
    expect(unreadSaved.articles.map((a) => a.id)).toEqual(['article-quantum']);

    // Plain-text FTS5 searches index article.categories as well as feed.category
    const byArticleCategory = searchArticles({
      query: 'environment',
      sort: 'relevance',
    });
    expect(byArticleCategory.articles.map((a) => a.id)).toEqual([
      'article-climate',
    ]);

    // is:saved does not exclude hidden bookmarks
    db.prepare('UPDATE articles SET hidden = 1 WHERE id = ?').run(
      'article-quantum',
    );
    const savedWhileHidden = searchArticles({
      query: 'is:saved',
      sort: 'recent',
    });
    expect(savedWhileHidden.articles.map((a) => a.id)).toContain(
      'article-quantum',
    );

    // Trigger delete removes row from article_search via rowid lookup
    db.prepare('DELETE FROM articles WHERE id = ?').run('article-climate');
    expect(
      searchArticles({ query: 'climate', sort: 'relevance' }).articles,
    ).toHaveLength(0);
  });
});
