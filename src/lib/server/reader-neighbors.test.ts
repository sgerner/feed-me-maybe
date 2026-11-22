import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createTestDb,
  insertTestArticle,
  insertTestFeed,
  type TestDbHandle,
} from '#lib/server/db/test-db.ts';

describe('stream-aware reader server neighbors', () => {
  let testDb: TestDbHandle;

  beforeAll(() => {
    testDb = createTestDb('feed-me-maybe-reader-neighbors-');
  });

  beforeEach(() => {
    testDb.reset();
    testDb.db
      .prepare("DELETE FROM app_settings WHERE key != 'admin_password_hash'")
      .run();
  });

  afterAll(() => {
    testDb.cleanup();
  });

  it('computes /inbox neighbors before recordInteraction marks read/hidden and supports reloading already-read /inbox stories', async () => {
    const { load } = await import('../../routes/articles/[id]/+page.server');
    const db = testDb.db;
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
    ).run('hide_on_open', 'false', now);

    const feedA = insertTestFeed(db, {
      id: 'feed-a',
      title: 'Feed A',
      category: 'Tech',
      now,
    });
    const feedB = insertTestFeed(db, {
      id: 'feed-b',
      title: 'Feed B',
      category: 'Tech',
      now,
    });

    const { refreshCombinedScore } = await import('#lib/server/scoring.ts');
    const setAiScore = (id: string, score: number) => {
      db.prepare(
        `INSERT OR REPLACE INTO article_ai_metadata (
          article_id, analysis_status, ai_relevance_score, quality_score, novelty_score, created_at
        ) VALUES (?, 'ready', ?, ?, ?, ?)`,
      ).run(id, score, score, score, now);
      refreshCombinedScore(id);
    };

    insertTestArticle(db, {
      id: 'inbox-1',
      feedId: feedA,
      title: 'Top Unread',
      heuristicScore: 50,
      publishedAt: now - 10_000,
      fetchedAt: now - 10_000,
      read: 0,
      now,
    });
    insertTestArticle(db, {
      id: 'inbox-read',
      feedId: feedA,
      title: 'Already Read Before Session',
      heuristicScore: 52,
      publishedAt: now - 15_000,
      fetchedAt: now - 15_000,
      read: 1,
      now,
    });
    insertTestArticle(db, {
      id: 'inbox-2',
      feedId: feedB,
      title: 'Middle Unread Across Feed B',
      heuristicScore: 50,
      publishedAt: now - 20_000,
      fetchedAt: now - 20_000,
      read: 0,
      now,
    });
    insertTestArticle(db, {
      id: 'inbox-3',
      feedId: feedA,
      title: 'Third Unread',
      heuristicScore: 50,
      publishedAt: now - 30_000,
      fetchedAt: now - 30_000,
      read: 0,
      now,
    });
    setAiScore('inbox-1', 1.0);
    setAiScore('inbox-read', 0.85);
    setAiScore('inbox-2', 0.5);
    setAiScore('inbox-3', 0.05);

    // First open of `inbox-2` from `/inbox`: neighbors skip `inbox-read` and span feeds A and B
    const firstLoad = (await load({
      params: { id: 'inbox-2' },
      locals: { sessionId: 'sess' },
      url: new URL('http://localhost/articles/inbox-2?mode=app&from=%2Finbox'),
    } as never)) as {
      article: { read: number };
      neighbors: { previous: string | null; next: string | null };
      returnPath: string;
    };

    expect(firstLoad.article.read).toBe(1);
    expect(firstLoad.returnPath).toBe('/inbox');
    expect(firstLoad.neighbors).toEqual({
      previous: 'inbox-1',
      next: 'inbox-3',
    });

    // Reloading `inbox-2` while it is now already `read = 1` still keeps its `/inbox` neighbors
    const reloaded = (await load({
      params: { id: 'inbox-2' },
      locals: { sessionId: 'sess' },
      url: new URL('http://localhost/articles/inbox-2?mode=app&from=%2Finbox'),
    } as never)) as {
      neighbors: { previous: string | null; next: string | null };
      returnPath: string;
    };

    expect(reloaded.returnPath).toBe('/inbox');
    expect(reloaded.neighbors).toEqual({
      previous: 'inbox-1',
      next: 'inbox-3',
    });

    // With `hide_on_open = true`, opening `inbox-1` resolves `next: 'inbox-3'` BEFORE hiding `inbox-1`
    db.prepare(
      'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
    ).run('hide_on_open', 'true', now);

    const hiddenOnOpenLoad = (await load({
      params: { id: 'inbox-1' },
      locals: { sessionId: 'sess' },
      url: new URL('http://localhost/articles/inbox-1?mode=app&from=%2Finbox'),
    } as never)) as {
      article: { hidden: number; read: number };
      neighbors: { previous: string | null; next: string | null };
    };

    expect(hiddenOnOpenLoad.article.read).toBe(1);
    expect(hiddenOnOpenLoad.article.hidden).toBe(1);
    expect(hiddenOnOpenLoad.neighbors).toEqual({
      previous: null,
      next: 'inbox-3',
    });
  });

  it('matches /, /feeds/[id], /saved, /recovery, /search, and bare single-feed fallback filters', async () => {
    const { load } = await import('../../routes/articles/[id]/+page.server');
    const db = testDb.db;
    const now = Date.now();

    const techFeed = insertTestFeed(db, {
      id: 'feed-tech',
      title: 'Tech Daily',
      category: 'Tech',
      now,
    });
    const newsFeed = insertTestFeed(db, {
      id: 'feed-news',
      title: 'World News',
      category: 'News',
      now,
    });

    insertTestArticle(db, {
      id: 'a-tech-1',
      feedId: techFeed,
      title: 'SQLite Window Functions Guide',
      content: 'Deep dive into sqlite window lag and lead queries',
      heuristicScore: 80,
      publishedAt: now - 30_000,
      fetchedAt: now - 30_000,
      saved: 1,
      now,
    });
    insertTestArticle(db, {
      id: 'a-news-1',
      feedId: newsFeed,
      title: 'SQLite Release Notes',
      content: 'New sqlite release announcement',
      heuristicScore: 70,
      publishedAt: now - 20_000,
      fetchedAt: now - 20_000,
      saved: 1,
      now,
    });
    insertTestArticle(db, {
      id: 'a-tech-2',
      feedId: techFeed,
      title: 'SvelteKit Streaming Architecture',
      content: 'Building fast sqlite readers',
      heuristicScore: 60,
      publishedAt: now - 10_000,
      fetchedAt: now - 10_000,
      saved: 1,
      now,
    });

    db.prepare('UPDATE articles SET saved_at = ? WHERE id = ?').run(
      now - 3_000,
      'a-tech-1',
    );
    db.prepare('UPDATE articles SET saved_at = ? WHERE id = ?').run(
      now - 1_000,
      'a-news-1',
    );
    db.prepare('UPDATE articles SET saved_at = ? WHERE id = ?').run(
      now - 2_000,
      'a-tech-2',
    );

    // 1. Bare `/articles/a-tech-1` stays scoped to `feed-tech` (single-feed fallback)
    const bareLoad = (await load({
      params: { id: 'a-tech-1' },
      locals: { sessionId: 'sess' },
      url: new URL('http://localhost/articles/a-tech-1'),
    } as never)) as {
      neighbors: { previous: string | null; next: string | null };
      returnPath: string;
    };
    expect(bareLoad.returnPath).toBe('/');
    expect(bareLoad.neighbors).toEqual({
      previous: 'a-tech-2',
      next: null,
    });

    // 2. Global `/?sort=oldest` spans both feeds in ascending timestamp order
    const oldestLoad = (await load({
      params: { id: 'a-news-1' },
      locals: { sessionId: 'sess' },
      url: new URL(
        'http://localhost/articles/a-news-1?from=%2F%3Fsort%3Doldest',
      ),
    } as never)) as {
      neighbors: { previous: string | null; next: string | null };
      returnPath: string;
    };
    expect(oldestLoad.returnPath).toBe('/?sort=oldest');
    expect(oldestLoad.neighbors).toEqual({
      previous: 'a-tech-1',
      next: 'a-tech-2',
    });

    // 3. Category filter `/?category=Tech&sort=newest` excludes `feed-news`
    const categoryLoad = (await load({
      params: { id: 'a-tech-2' },
      locals: { sessionId: 'sess' },
      url: new URL(
        'http://localhost/articles/a-tech-2?from=%2F%3Fcategory%3DTech%26sort%3Dnewest',
      ),
    } as never)) as {
      neighbors: { previous: string | null; next: string | null };
    };
    expect(categoryLoad.neighbors).toEqual({
      previous: null,
      next: 'a-tech-1',
    });

    // 4. `/saved` orders by `saved_at DESC` (`a-news-1` -> `a-tech-2` -> `a-tech-1`)
    const savedLoad = (await load({
      params: { id: 'a-tech-2' },
      locals: { sessionId: 'sess' },
      url: new URL('http://localhost/articles/a-tech-2?from=%2Fsaved'),
    } as never)) as {
      neighbors: { previous: string | null; next: string | null };
      returnPath: string;
    };
    expect(savedLoad.returnPath).toBe('/saved');
    expect(savedLoad.neighbors).toEqual({
      previous: 'a-news-1',
      next: 'a-tech-1',
    });

    // 5. `/search?q=sqlite&sort=recent` matches FTS results ordered by recent
    const searchLoad = (await load({
      params: { id: 'a-news-1' },
      locals: { sessionId: 'sess' },
      url: new URL(
        'http://localhost/articles/a-news-1?from=%2Fsearch%3Fq%3Dsqlite%26sort%3Drecent',
      ),
    } as never)) as {
      neighbors: { previous: string | null; next: string | null };
      returnPath: string;
    };
    expect(searchLoad.returnPath).toBe('/search?q=sqlite&sort=recent');
    expect(searchLoad.neighbors).toEqual({
      previous: 'a-tech-2',
      next: 'a-tech-1',
    });

    // 6. `/recovery` orders hidden/rejected items by `COALESCE(hidden_at, rejected_at, fetched_at) DESC`
    insertTestArticle(db, {
      id: 'rec-1',
      feedId: techFeed,
      title: 'Hidden Earlier',
      hidden: 1,
      fetchedAt: now - 50_000,
      now,
    });
    insertTestArticle(db, {
      id: 'rec-2',
      feedId: newsFeed,
      title: 'Rejected Middle',
      rejected: 1,
      thumbsDown: 1,
      fetchedAt: now - 40_000,
      now,
    });
    insertTestArticle(db, {
      id: 'rec-3',
      feedId: techFeed,
      title: 'Hidden Latest',
      hidden: 1,
      fetchedAt: now - 35_000,
      now,
    });
    db.prepare('UPDATE articles SET hidden_at = ? WHERE id = ?').run(
      now - 5_000,
      'rec-1',
    );
    db.prepare('UPDATE articles SET rejected_at = ? WHERE id = ?').run(
      now - 3_000,
      'rec-2',
    );
    db.prepare('UPDATE articles SET hidden_at = ? WHERE id = ?').run(
      now - 1_000,
      'rec-3',
    );

    const recoveryLoad = (await load({
      params: { id: 'rec-2' },
      locals: { sessionId: 'sess' },
      url: new URL('http://localhost/articles/rec-2?from=%2Frecovery'),
    } as never)) as {
      neighbors: { previous: string | null; next: string | null };
      returnPath: string;
    };
    expect(recoveryLoad.returnPath).toBe('/recovery');
    expect(recoveryLoad.neighbors).toEqual({
      previous: 'rec-3',
      next: 'rec-1',
    });

    // 7. `/feeds/[id]?unread=1` scopes to that feed's unread stream
    insertTestArticle(db, {
      id: 'f-unread-1',
      feedId: techFeed,
      title: 'Feed Unread 1',
      heuristicScore: 95,
      read: 0,
      now,
    });
    insertTestArticle(db, {
      id: 'f-unread-2',
      feedId: techFeed,
      title: 'Feed Unread 2',
      heuristicScore: 85,
      read: 0,
      now,
    });
    const feedUnreadLoad = (await load({
      params: { id: 'f-unread-1' },
      locals: { sessionId: 'sess' },
      url: new URL(
        'http://localhost/articles/f-unread-1?from=%2Ffeeds%2Ffeed-tech%3Funread%3D1',
      ),
    } as never)) as {
      neighbors: { previous: string | null; next: string | null };
      returnPath: string;
    };
    expect(feedUnreadLoad.returnPath).toBe('/feeds/feed-tech?unread=1');
    expect(feedUnreadLoad.neighbors).toEqual({
      previous: null,
      next: 'f-unread-2',
    });
  });

  it('skips LLM calls when from=/digest without sessionStorage and resolves cached or null neighbors', async () => {
    const runtimeModule = await import('#lib/server/ai/runtime.ts');
    const aiSpy = vi.spyOn(runtimeModule, 'getConfiguredAiClient');
    const { load } = await import('../../routes/articles/[id]/+page.server');
    const { getWeeklyDigestArticles } = await import('#lib/server/digest.ts');
    const db = testDb.db;
    const now = Date.now();

    db.prepare(
      'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
    ).run('ai_enabled', 'true', now);

    const feedId = insertTestFeed(db, {
      id: 'digest-feed',
      title: 'Digest Feed',
      now,
    });
    const { refreshCombinedScore } = await import('#lib/server/scoring.ts');
    insertTestArticle(db, {
      id: 'dig-1',
      feedId,
      title: 'Digest Story One',
      heuristicScore: 50,
      publishedAt: now - 10_000,
      fetchedAt: now - 10_000,
      now,
    });
    insertTestArticle(db, {
      id: 'dig-2',
      feedId,
      title: 'Digest Story Two',
      heuristicScore: 50,
      publishedAt: now - 20_000,
      fetchedAt: now - 20_000,
      now,
    });
    db.prepare(
      `INSERT OR REPLACE INTO article_ai_metadata (
        article_id, analysis_status, ai_relevance_score, quality_score, novelty_score, created_at
      ) VALUES (?, 'ready', 1.0, 1.0, 1.0, ?), (?, 'ready', 0.1, 0.1, 0.1, ?)`,
    ).run('dig-1', now, 'dig-2', now);
    refreshCombinedScore('dig-1');
    refreshCombinedScore('dig-2');

    // Uncached digest: must NOT invoke AI client and must return returnPath = '/digest' with null neighbors
    const uncachedLoad = (await load({
      params: { id: 'dig-1' },
      locals: { sessionId: 'sess' },
      url: new URL('http://localhost/articles/dig-1?mode=app&from=%2Fdigest'),
    } as never)) as {
      neighbors: { previous: string | null; next: string | null };
      returnPath: string;
    };

    expect(aiSpy).not.toHaveBeenCalled();
    expect(uncachedLoad.returnPath).toBe('/digest');
    expect(uncachedLoad.neighbors).toEqual({ previous: null, next: null });

    // Populate heuristic digest cache (with AI disabled), then re-enable AI and verify cached neighbors resolve without AI calls
    db.prepare(
      'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
    ).run('ai_enabled', 'false', now);
    await getWeeklyDigestArticles({ now, windowDays: 7 });
    db.prepare(
      'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
    ).run('ai_enabled', 'true', now);
    aiSpy.mockClear();

    const cachedLoad = (await load({
      params: { id: 'dig-1' },
      locals: { sessionId: 'sess' },
      url: new URL('http://localhost/articles/dig-1?mode=app&from=%2Fdigest'),
    } as never)) as {
      neighbors: { previous: string | null; next: string | null };
      returnPath: string;
    };

    expect(aiSpy).not.toHaveBeenCalled();
    expect(cachedLoad.returnPath).toBe('/digest');
    expect(cachedLoad.neighbors).toEqual({
      previous: null,
      next: 'dig-2',
    });

    aiSpy.mockRestore();
  });

  it('rejects unsafe from values on server load so returnPath never creates open redirects or self-loops', async () => {
    const { load } = await import('../../routes/articles/[id]/+page.server');
    const db = testDb.db;
    const now = Date.now();
    const feedId = insertTestFeed(db, { id: 'safe-feed', now });
    insertTestArticle(db, { id: 'safe-1', feedId, now });

    for (const badFrom of [
      'https://evil.example/phish',
      '//evil.example',
      '/\\evil.example',
      '/articles/safe-1',
    ]) {
      const result = (await load({
        params: { id: 'safe-1' },
        locals: { sessionId: 'sess' },
        url: new URL(
          `http://localhost/articles/safe-1?from=${encodeURIComponent(badFrom)}`,
        ),
      } as never)) as { returnPath: string };
      expect(result.returnPath).toBe('/');
    }
  });
});
