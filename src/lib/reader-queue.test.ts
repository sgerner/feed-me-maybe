import { describe, expect, it } from 'vitest';
import {
  applyQueuePageResponse,
  buildQueueNextPageRequest,
  buildReaderArticleHref,
  parseStoredReaderQueue,
  resolveReaderReturnPath,
  serializeReaderQueue,
  shouldPrefetchReaderQueue,
  validateStreamOrigin,
  type ReaderQueue,
} from './reader-queue';

describe('reader stream origin validation and returnPath routing', () => {
  it('accepts valid in-app stream paths and preserves query strings', () => {
    expect(validateStreamOrigin('/')).toBe('/');
    expect(validateStreamOrigin('/inbox')).toBe('/inbox');
    expect(validateStreamOrigin('/?category=Tech&sort=newest')).toBe(
      '/?category=Tech&sort=newest',
    );
    expect(validateStreamOrigin('/feeds/feed-1?unread=1&sort=oldest')).toBe(
      '/feeds/feed-1?unread=1&sort=oldest',
    );
    expect(validateStreamOrigin('/saved')).toBe('/saved');
    expect(validateStreamOrigin('/digest')).toBe('/digest');
    expect(validateStreamOrigin('/recovery?kind=hidden')).toBe(
      '/recovery?kind=hidden',
    );
    expect(validateStreamOrigin('/search?q=rust+is%3Aunread&sort=recent')).toBe(
      '/search?q=rust+is%3Aunread&sort=recent',
    );
  });

  it('rejects external, protocol-relative, backslash, /articles/, /login, and /api/ values', () => {
    expect(validateStreamOrigin('https://evil.example/steal')).toBeNull();
    expect(validateStreamOrigin('http://localhost:5173/inbox')).toBeNull();
    expect(validateStreamOrigin('//evil.example/path')).toBeNull();
    expect(validateStreamOrigin('/\\evil.example')).toBeNull();
    expect(validateStreamOrigin('\\evil.example')).toBeNull();
    expect(validateStreamOrigin('/inbox\\..\\evil')).toBeNull();
    expect(validateStreamOrigin('/articles')).toBeNull();
    expect(validateStreamOrigin('/articles/art-1')).toBeNull();
    expect(validateStreamOrigin('/articles/art-1?mode=app')).toBeNull();
    expect(validateStreamOrigin('/login')).toBeNull();
    expect(validateStreamOrigin('/login?returnTo=/inbox')).toBeNull();
    expect(validateStreamOrigin('/api/articles')).toBeNull();
    expect(validateStreamOrigin('javascript:alert(1)')).toBeNull();
    expect(validateStreamOrigin('/inbox\u0000')).toBeNull();
    expect(validateStreamOrigin('')).toBeNull();
    expect(validateStreamOrigin(null)).toBeNull();
  });

  it('resolves returnPath to active stream even without sessionStorage and blocks unsafe from values', () => {
    expect(
      resolveReaderReturnPath({
        rawFrom: '/digest',
        hasQueueMatch: false,
      }),
    ).toBe('/digest');

    expect(
      resolveReaderReturnPath({
        rawFrom: '/inbox?sort=newest',
        hasQueueMatch: false,
      }),
    ).toBe('/inbox?sort=newest');

    // Explicit invalid `from` never falls back to stale storage or open redirects
    for (const unsafe of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/articles/other-story',
    ]) {
      expect(
        resolveReaderReturnPath({
          rawFrom: unsafe,
          queueSource: '/inbox',
          hasQueueMatch: true,
          referrer: 'http://localhost/saved',
          currentOrigin: 'http://localhost',
        }),
      ).toBe('/');
    }

    // Bare `/articles/[id]` uses same-origin referrer when valid, else `/`
    expect(
      resolveReaderReturnPath({
        rawFrom: null,
        hasQueueMatch: false,
        referrer: 'http://localhost/feeds/feed-1?unread=1',
        currentOrigin: 'http://localhost',
      }),
    ).toBe('/feeds/feed-1?unread=1');

    expect(
      resolveReaderReturnPath({
        rawFrom: null,
        hasQueueMatch: false,
        referrer: 'http://localhost/articles/prev-id',
        currentOrigin: 'http://localhost',
      }),
    ).toBe('/');
  });

  it('preserves mode and validated URL-encoded from in buildReaderArticleHref', () => {
    expect(
      buildReaderArticleHref('art-1', {
        mode: 'app',
        from: '/inbox?category=AI&sort=newest',
      }),
    ).toBe(
      '/articles/art-1?mode=app&from=%2Finbox%3Fcategory%3DAI%26sort%3Dnewest',
    );

    expect(
      buildReaderArticleHref('art-1', {
        mode: 'app',
        from: '//evil.example',
      }),
    ).toBe('/articles/art-1?mode=app');

    expect(
      buildReaderArticleHref('art-1', {
        from: '/recovery',
      }),
    ).toBe('/articles/art-1?from=%2Frecovery');
  });
});

describe('stale-queue rejection and cross-page reader queues', () => {
  it('accepts matching queues and rejects stale queues from other routes or bare URLs', () => {
    const raw = serializeReaderQueue({
      ids: ['a1', 'a2', 'a3'],
      source: '/inbox',
      pagination: {
        kind: 'articles',
        hasMore: true,
        page: 1,
        limit: 25,
        removedCount: 0,
        params: { unread: '1' },
      },
    });

    expect(
      parseStoredReaderQueue(raw, {
        articleId: 'a2',
        rawFrom: '/inbox',
      }),
    ).toMatchObject({
      ids: ['a1', 'a2', 'a3'],
      source: '/inbox',
    });

    // Stale queue when navigating from /saved or /digest
    expect(
      parseStoredReaderQueue(raw, {
        articleId: 'a2',
        rawFrom: '/saved',
      }),
    ).toBeNull();

    expect(
      parseStoredReaderQueue(raw, {
        articleId: 'a2',
        rawFrom: '/digest',
      }),
    ).toBeNull();

    // Stale queue rejected on bare /articles/a2 without matching referrer
    expect(
      parseStoredReaderQueue(raw, {
        articleId: 'a2',
        rawFrom: null,
      }),
    ).toBeNull();

    expect(
      parseStoredReaderQueue(raw, {
        articleId: 'a2',
        rawFrom: null,
        referrer: 'http://localhost/settings/status',
        currentOrigin: 'http://localhost',
      }),
    ).toBeNull();

    // Accepted on bare URL only if same-origin referrer matches stored source
    expect(
      parseStoredReaderQueue(raw, {
        articleId: 'a2',
        rawFrom: null,
        referrer: 'http://localhost/inbox',
        currentOrigin: 'http://localhost',
      }),
    ).not.toBeNull();
  });

  it('prefetches and appends cross-page /api/articles queues past item 25 while deduplicating IDs', () => {
    const firstPageIds = Array.from(
      { length: 25 },
      (_, idx) => `id-${idx + 1}`,
    );
    const queue: ReaderQueue = {
      ids: firstPageIds,
      source: '/inbox',
      pagination: {
        kind: 'articles',
        hasMore: true,
        page: 1,
        limit: 25,
        removedCount: 0,
        initialPage: 1,
        feedId: null,
        params: { unread: '1', snapshotAt: '1700000000000' },
      },
    };

    expect(shouldPrefetchReaderQueue(queue, 'id-20')).toBe(false);
    expect(shouldPrefetchReaderQueue(queue, 'id-22')).toBe(true);
    expect(shouldPrefetchReaderQueue(queue, 'id-25')).toBe(true);

    const requestUrl = buildQueueNextPageRequest(queue, ['id-3']);
    expect(requestUrl).toBeTruthy();
    const parsedUrl = new URL(requestUrl!, 'http://localhost');
    expect(parsedUrl.pathname).toBe('/api/articles');
    expect(parsedUrl.searchParams.get('page')).toBe('2');
    expect(parsedUrl.searchParams.get('offset')).toBe('24');
    expect(parsedUrl.searchParams.get('unread')).toBe('1');
    expect(parsedUrl.searchParams.get('snapshotAt')).toBe('1700000000000');
    expect(parsedUrl.searchParams.get('excludeIds')?.split(',')).not.toContain(
      'id-3',
    );

    // Response includes duplicate `id-25`, dismissed `id-3`, and 24 new items (25 total rows -> hasMore stays true)
    const secondPageArticles = [
      { id: 'id-25' },
      ...Array.from({ length: 24 }, (_, idx) => ({ id: `id-${idx + 26}` })),
    ];
    const updated = applyQueuePageResponse(
      queue,
      { articles: secondPageArticles },
      ['id-3'],
    );
    expect(updated.ids).toHaveLength(49);
    expect(updated.ids[24]).toBe('id-25');
    expect(updated.ids[25]).toBe('id-26');
    expect(updated.ids[48]).toBe('id-49');
    expect(updated.pagination).toMatchObject({
      kind: 'articles',
      page: 2,
      hasMore: true,
    });

    // Final partial page marks hasMore = false
    const finalQueue = applyQueuePageResponse(updated, {
      articles: [{ id: 'id-50' }, { id: 'id-51' }],
    });
    expect(finalQueue.ids.slice(-2)).toEqual(['id-50', 'id-51']);
    expect(finalQueue.pagination).toMatchObject({
      kind: 'articles',
      page: 3,
      hasMore: false,
    });
    expect(shouldPrefetchReaderQueue(finalQueue, 'id-51')).toBe(false);
  });

  it('paginates cursor queues for /api/search and /api/article-state/recovery', () => {
    const searchQueue: ReaderQueue = {
      ids: ['s-1', 's-2'],
      source: '/search?q=is%3Aunread',
      pagination: {
        kind: 'search',
        nextCursor: 'cursor-1',
        query: 'is:unread',
        sort: 'relevance',
      },
    };

    expect(shouldPrefetchReaderQueue(searchQueue, 's-1')).toBe(true);
    const searchUrl = new URL(
      buildQueueNextPageRequest(searchQueue)!,
      'http://localhost',
    );
    expect(searchUrl.pathname).toBe('/api/search');
    expect(searchUrl.searchParams.get('q')).toBe('is:unread');
    expect(searchUrl.searchParams.get('cursor')).toBe('cursor-1');
    // Relevance is omitted so filter-only queries let the server choose recent
    expect(searchUrl.searchParams.get('sort')).toBeNull();

    const updatedSearch = applyQueuePageResponse(searchQueue, {
      articles: [{ id: 's-2' }, { id: 's-3' }, { id: 's-4' }],
      nextCursor: 'cursor-2',
    });
    expect(updatedSearch.ids).toEqual(['s-1', 's-2', 's-3', 's-4']);
    expect(updatedSearch.pagination).toMatchObject({
      kind: 'search',
      nextCursor: 'cursor-2',
    });

    const recoveryQueue: ReaderQueue = {
      ids: ['r-1', 'r-2'],
      source: '/recovery?kind=rejected',
      pagination: {
        kind: 'recovery',
        nextCursor: 'rec-cursor-1',
        limit: 50,
        kindFilter: 'rejected',
      },
    };
    const recoveryUrl = new URL(
      buildQueueNextPageRequest(recoveryQueue)!,
      'http://localhost',
    );
    expect(recoveryUrl.pathname).toBe('/api/article-state/recovery');
    expect(recoveryUrl.searchParams.get('cursor')).toBe('rec-cursor-1');
    expect(recoveryUrl.searchParams.get('kind')).toBe('rejected');
    expect(recoveryUrl.searchParams.get('limit')).toBe('50');

    const exhaustedRecovery = applyQueuePageResponse(recoveryQueue, {
      articles: [{ id: 'r-3' }],
      nextCursor: null,
    });
    expect(exhaustedRecovery.ids).toEqual(['r-1', 'r-2', 'r-3']);
    expect(exhaustedRecovery.pagination).toMatchObject({
      kind: 'recovery',
      nextCursor: null,
    });
    expect(shouldPrefetchReaderQueue(exhaustedRecovery, 'r-3')).toBe(false);

    const filteredRecoveryQueue: ReaderQueue = {
      ids: ['r-filtered-1'],
      source: '/recovery?reason=hide_on_open&feedId=feed-1&q=paywall',
      pagination: {
        kind: 'recovery',
        nextCursor: 'filtered-cursor',
        limit: 50,
        feedId: 'feed-1',
        reason: 'hide_on_open',
        query: 'paywall',
      },
    };
    const filteredRecoveryUrl = new URL(
      buildQueueNextPageRequest(filteredRecoveryQueue)!,
      'http://localhost',
    );
    expect(filteredRecoveryUrl.searchParams.get('reason')).toBe('hide_on_open');
    expect(filteredRecoveryUrl.searchParams.get('feedId')).toBe('feed-1');
    expect(filteredRecoveryUrl.searchParams.get('q')).toBe('paywall');
  });
});
