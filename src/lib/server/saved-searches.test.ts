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
import { applyArticleState } from '#lib/server/article-state.ts';
import { initializeDatabase } from '#lib/server/db/migrate.ts';
import { getDb } from '#lib/server/db/index.ts';
import {
  createSavedSearch,
  deleteSavedSearch,
  listPinnedSavedSearches,
  listSavedSearches,
  SavedSearchError,
  updateSavedSearch,
} from './saved-searches';
import { load as loadLayout } from '../../routes/+layout.server';

describe('saved searches service, counts, and migration', () => {
  let testDb: TestDbHandle;

  beforeAll(() => {
    testDb = createTestDb('feed-me-maybe-saved-searches-');
  });

  beforeEach(() => {
    testDb.reset();
    const db = testDb.db;
    const now = Date.now();

    insertTestFeed(db, {
      id: 'feed-science',
      url: 'https://example.com/science.xml',
      title: 'Science Daily',
      category: 'science',
      enabled: 1,
      now,
    });
    insertTestFeed(db, {
      id: 'feed-paused',
      url: 'https://example.com/paused.xml',
      title: 'Paused Lab Notes',
      category: 'science',
      enabled: 0,
      now,
    });

    insertTestArticle(db, {
      id: 'art-unread',
      feedId: 'feed-science',
      url: 'https://example.com/quantum-1',
      title: 'Quantum computing milestone',
      summary: 'Unread science story about quantum hardware.',
      content: 'Detailed quantum processor benchmark.',
      publishedAt: now - 1_000,
      fetchedAt: now - 1_000,
      read: 0,
      saved: 1,
      hidden: 0,
      thumbsDown: 0,
      rejected: 0,
      now,
    });
    insertTestArticle(db, {
      id: 'art-read',
      feedId: 'feed-science',
      url: 'https://example.com/quantum-2',
      title: 'Quantum theory retrospective',
      summary: 'Already read quantum article.',
      content: 'Historical overview of quantum mechanics.',
      publishedAt: now - 2_000,
      fetchedAt: now - 2_000,
      read: 1,
      saved: 0,
      hidden: 0,
      thumbsDown: 0,
      rejected: 0,
      now,
    });
    insertTestArticle(db, {
      id: 'art-hidden',
      feedId: 'feed-science',
      url: 'https://example.com/quantum-hidden',
      title: 'Hidden quantum rumor',
      summary: 'Unread but hidden quantum post.',
      content: 'Speculative quantum rumor.',
      publishedAt: now - 3_000,
      fetchedAt: now - 3_000,
      read: 0,
      saved: 1,
      hidden: 1,
      thumbsDown: 0,
      rejected: 0,
      now,
    });
    insertTestArticle(db, {
      id: 'art-rejected',
      feedId: 'feed-science',
      url: 'https://example.com/quantum-rejected',
      title: 'Rejected quantum clickbait',
      summary: 'Unread rejected quantum story.',
      content: 'Low-quality quantum hype.',
      publishedAt: now - 4_000,
      fetchedAt: now - 4_000,
      read: 0,
      saved: 1,
      hidden: 0,
      thumbsDown: 1,
      rejected: 1,
      now,
    });
    insertTestArticle(db, {
      id: 'art-paused',
      feedId: 'feed-paused',
      url: 'https://example.com/quantum-paused',
      title: 'Paused feed quantum note',
      summary: 'Unread quantum note from a paused feed.',
      content: 'Paused quantum experiment log.',
      publishedAt: now - 5_000,
      fetchedAt: now - 5_000,
      read: 0,
      saved: 1,
      hidden: 0,
      thumbsDown: 0,
      rejected: 0,
      now,
    });
  });

  afterAll(() => {
    testDb.cleanup();
  });

  it('persists sort modes and coerces filter-only or negation-only queries to recent', () => {
    const newestText = createSavedSearch({
      name: 'Quantum Newest',
      query: 'quantum',
      sort: 'recent',
      pinned: true,
    });
    expect(newestText.sort).toBe('recent');

    const defaultRelevance = createSavedSearch({
      name: 'Quantum Relevance',
      query: 'quantum',
      pinned: false,
    });
    expect(defaultRelevance.sort).toBe('relevance');

    const filterOnly = createSavedSearch({
      name: 'Science Unread',
      query: 'category:science is:unread',
      sort: 'relevance',
      pinned: true,
    });
    expect(filterOnly.sort).toBe('recent');

    const negationOnly = createSavedSearch({
      name: 'No Clickbait',
      query: '-clickbait',
      sort: 'relevance',
      pinned: false,
    });
    expect(negationOnly.sort).toBe('recent');

    // Updating a relevance search to a filter-only query without passing sort coerces to recent
    const updatedToFilter = updateSavedSearch(defaultRelevance.id, {
      query: 'is:unread category:science',
    });
    expect(updatedToFilter.sort).toBe('recent');

    // Validation errors on invalid sort or syntax
    expect(() =>
      createSavedSearch({
        name: 'Bad Sort',
        query: 'quantum',
        sort: 'oldest' as never,
      }),
    ).toThrow(SavedSearchError);
    expect(() =>
      createSavedSearch({
        name: 'Empty Query',
        query: '   ',
      }),
    ).toThrow(SavedSearchError);
  });

  it('excludes paused feeds, hidden articles, and rejected articles from unread badges unless explicitly targeted', () => {
    // Standard topic search: art-unread + art-read + art-rejected (hidden=0) are visible in search,
    // while unread badge excludes art-read (read=1), art-hidden (hidden=1), art-rejected (rejected=1), and art-paused (enabled=0).
    const standard = createSavedSearch({
      name: 'Quantum Watch',
      query: 'quantum',
      pinned: true,
    });
    expect(standard.unreadCount).toBe(1);
    expect(standard.totalCount).toBe(3);

    // is:saved includes hidden/paused/rejected bookmarks in totalCount (4 saved items),
    // but unread badge still excludes paused, hidden, and rejected items (only art-unread counts).
    const savedBookmarks = createSavedSearch({
      name: 'Saved Quantum',
      query: 'quantum is:saved',
      pinned: true,
    });
    expect(savedBookmarks.totalCount).toBe(4);
    expect(savedBookmarks.unreadCount).toBe(1);

    // Explicitly targeting a paused feed includes its unread non-hidden non-rejected items.
    const explicitPausedFeed = createSavedSearch({
      name: 'Paused Lab',
      query: 'quantum feed:"Paused Lab Notes"',
      pinned: true,
    });
    expect(explicitPausedFeed.totalCount).toBe(1);
    expect(explicitPausedFeed.unreadCount).toBe(1);

    // Explicitly targeting hidden items counts unread hidden items (not rejected or paused).
    const explicitHidden = createSavedSearch({
      name: 'Hidden Quantum',
      query: 'quantum is:hidden',
      pinned: true,
    });
    expect(explicitHidden.totalCount).toBe(1);
    expect(explicitHidden.unreadCount).toBe(1);

    // Explicitly targeting rejected items counts unread rejected items from enabled feeds.
    const explicitRejected = createSavedSearch({
      name: 'Rejected Quantum',
      query: 'quantum is:rejected',
      pinned: true,
    });
    expect(explicitRejected.totalCount).toBe(1);
    expect(explicitRejected.unreadCount).toBe(1);
  });

  it('updates sidebar pinned searches and unread counts after triage and unpinning', async () => {
    const pinned = createSavedSearch({
      name: 'Quantum Monitor',
      query: 'quantum',
      sort: 'recent',
      pinned: true,
    });
    const unpinned = createSavedSearch({
      name: 'Archive Query',
      query: 'retrospective',
      pinned: false,
    });

    const depends = vi.fn();
    const initialLayout = (await loadLayout({
      locals: { sessionId: 'session-1' },
      depends,
    } as never)) as {
      pinnedSearches: Array<{
        id: string;
        name: string;
        sort: string;
        unreadCount: number;
      }>;
    };

    expect(depends).toHaveBeenCalledWith('app:reader-counts');
    expect(initialLayout.pinnedSearches).toHaveLength(1);
    expect(initialLayout.pinnedSearches[0]).toMatchObject({
      id: pinned.id,
      name: 'Quantum Monitor',
      sort: 'recent',
      unreadCount: 1,
    });

    // Triage art-unread -> read; unreadCount drops to 0
    applyArticleState({
      articleIds: ['art-unread'],
      action: 'read',
      idempotencyKey: 'triage-read-1',
    });

    const afterRead = listPinnedSavedSearches();
    expect(afterRead[0]?.unreadCount).toBe(0);

    // Unpin removes from sidebar list while keeping in /search list
    updateSavedSearch(pinned.id, { pinned: false });
    expect(listPinnedSavedSearches()).toHaveLength(0);
    expect(listSavedSearches().map((item) => item.id)).toEqual(
      expect.arrayContaining([pinned.id, unpinned.id]),
    );

    expect(deleteSavedSearch(unpinned.id)).toBe(true);
  });

  it('applies migration v12 idempotently and backfills legacy saved_searches rows', () => {
    const db = getDb();
    const now = Date.now();

    // Simulate legacy rows prior to migration 12 with invalid/mismatched sort values
    db.prepare(
      `INSERT INTO saved_searches (id, name, query, description, sort, pinned, created_at, updated_at)
       VALUES (?, ?, ?, '', 'relevance', 1, ?, ?),
              (?, ?, ?, '', 'invalid_mode', 1, ?, ?)`,
    ).run(
      'legacy-filter',
      'Legacy Filter',
      'category:science is:unread',
      now,
      now,
      'legacy-text',
      'Legacy Text',
      'quantum',
      now,
      now,
    );
    db.prepare('DELETE FROM schema_migrations WHERE version = 12').run();

    initializeDatabase();
    initializeDatabase();

    const migrated = db
      .prepare('SELECT id, sort FROM saved_searches ORDER BY id ASC')
      .all() as Array<{ id: string; sort: string }>;
    expect(migrated).toEqual([
      { id: 'legacy-filter', sort: 'recent' },
      { id: 'legacy-text', sort: 'relevance' },
    ]);
  });
});
