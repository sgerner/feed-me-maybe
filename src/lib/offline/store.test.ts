import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => {
  const stores = new Map<string, Map<string, unknown>>();
  const meta = new Map<string, string | number>();
  const keyFor = (store: string, record: unknown) => {
    const value = record as { key?: string; id?: string };
    return value.key ?? value.id ?? '';
  };

  for (const name of ['articles', 'digests', 'outbox']) {
    stores.set(name, new Map());
  }

  return {
    stores,
    meta,
    reset() {
      for (const records of stores.values()) records.clear();
      meta.clear();
    },
    normalizeOfflineScope: (scope: string) => scope.trim(),
    scopedKey: (scope: string, id: string) => `${scope}\u0000${id}`,
    async getAllRecords(name: string) {
      return [...(stores.get(name)?.values() ?? [])];
    },
    async getMetaValue(key: string) {
      return meta.get(key);
    },
    async putMetaValue(key: string, value: string | number) {
      meta.set(key, value);
    },
    async clearOfflineStores() {
      for (const records of stores.values()) records.clear();
      meta.clear();
    },
    async putRecords(name: string, records: unknown[]) {
      const store = stores.get(name)!;
      for (const record of records) store.set(keyFor(name, record), record);
    },
    async replaceRecords(name: string, records: unknown[], removed: string[]) {
      const store = stores.get(name)!;
      for (const key of removed) store.delete(key);
      for (const record of records) store.set(keyFor(name, record), record);
    },
  };
});

vi.mock('./db', () => memory);

import {
  cacheArticles,
  cacheSavedArticles,
  getCachedArticles,
  getCachedSavedArticles,
  reconcileCachedFeed,
  refreshOfflineArticleBodies,
} from './store';
import type { CachedArticle, OfflineMutation } from './types';

function cachedArticle(id: string, updatedAt: number): CachedArticle {
  return {
    id,
    url: `https://example.com/${id}`,
    title: id,
    saved: true,
    cacheVersion: 'v1',
    scope: 'reader',
    key: `reader\u0000${id}`,
    cachedAt: updatedAt,
    updatedAt,
  };
}

describe('offline article cache', () => {
  beforeEach(() => memory.reset());

  it('normalizes SQLite flags and preserves full cached bodies during snapshot refresh', async () => {
    const existing = cachedArticle('saved-body', 10);
    existing.content = '<p>Full cached article</p>';
    memory.stores.get('articles')!.set(existing.key, existing);

    await refreshOfflineArticleBodies('reader', async () =>
      Response.json({
        articles: [],
        savedArticles: [
          {
            id: existing.id,
            title: existing.title,
            url: existing.url,
            saved: 1,
            read: 0,
            hidden: 1,
            content: null,
          },
        ],
      }),
    );

    expect(await getCachedSavedArticles('reader')).toMatchObject([
      {
        id: existing.id,
        saved: true,
        read: false,
        hidden: true,
        content: existing.content,
      },
    ]);
  });

  it('keeps a queued save when a refreshed saved list omits it and the cache is full', async () => {
    const pendingArticle = cachedArticle('pending-save', 1);
    memory.stores.get('articles')!.set(pendingArticle.key, pendingArticle);
    const mutation: OfflineMutation = {
      id: 'mutation-save',
      idempotencyKey: 'idempotency-save',
      scope: 'reader',
      articleId: 'pending-save',
      type: 'save',
      dedupeKey: 'pending-save:save',
      sequence: 1,
      queuedAt: 1,
      attempts: 0,
      nextAttemptAt: 1,
      state: 'pending',
    };
    memory.stores.get('outbox')!.set(mutation.id, mutation);

    await cacheSavedArticles(
      'reader',
      [
        {
          id: 'server-save',
          url: 'https://example.com/server-save',
          title: 'Server save',
          saved: true,
        },
      ],
      { savedArticles: 1 },
    );

    const saved = await getCachedSavedArticles('reader');
    expect(saved.map((article) => article.id)).toContain('pending-save');
  });

  it('removes a stale saved cache entry when no pending save protects it', async () => {
    const stale = cachedArticle('stale-save', 1);
    memory.stores.get('articles')!.set(stale.key, stale);

    await cacheSavedArticles('reader', []);

    expect(await getCachedSavedArticles('reader')).toEqual([]);
  });

  it('refreshes private unread and saved bodies without cacheable requests', async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init).toMatchObject({
          credentials: 'include',
          cache: 'no-store',
        });
        return Response.json({
          articles: [
            {
              id: 'unread-body',
              url: 'https://example.com/unread-body',
              title: 'Unread body',
              content: 'Cached article text',
              read: false,
            },
          ],
          savedArticles: [
            {
              id: 'saved-body',
              url: 'https://example.com/saved-body',
              title: 'Saved body',
              content: 'Saved article text',
              saved: true,
            },
          ],
        });
      },
    );

    await expect(
      refreshOfflineArticleBodies('reader', fetchImpl),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/offline/articles',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );
    expect(await getCachedArticles('reader')).toMatchObject([
      { id: 'saved-body', content: 'Saved article text', saved: true },
      { id: 'unread-body', content: 'Cached article text', read: false },
    ]);
    expect(await getCachedSavedArticles('reader')).toMatchObject([
      { id: 'saved-body', content: 'Saved article text' },
    ]);
  });

  it('keeps existing private bodies when the snapshot endpoint requires login', async () => {
    const existing = cachedArticle('offline-body', 10);
    existing.content = 'Previously cached text';
    memory.stores.get('articles')!.set(existing.key, existing);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));

    await expect(
      refreshOfflineArticleBodies('reader', fetchImpl),
    ).resolves.toBe(false);
    expect(await getCachedArticles('reader')).toMatchObject([
      { id: 'offline-body', content: 'Previously cached text' },
    ]);
  });

  it('authoritatively removes ghost articles omitted from snapshot and prioritizes ranked unread articles', async () => {
    const ghost = cachedArticle('ghost-article', 5);
    ghost.saved = false;
    ghost.read = false;
    memory.stores.get('articles')!.set(ghost.key, ghost);

    await refreshOfflineArticleBodies('reader', async () =>
      Response.json({
        articles: [
          {
            id: 'low-rank-newer',
            url: 'https://example.com/low',
            title: 'Low rank',
            published_at: 200,
            read: false,
            offline_rank_score: 10,
          },
          {
            id: 'high-rank-older',
            url: 'https://example.com/high',
            title: 'High rank',
            published_at: 100,
            read: false,
            offline_rank_score: 95,
          },
        ],
        savedArticles: [],
      }),
    );

    const cached = await getCachedArticles('reader');
    expect(cached.map((item) => item.id)).toEqual([
      'high-rank-older',
      'low-rank-newer',
    ]);

    await cacheArticles(
      'reader',
      [
        {
          id: 'newer-read',
          url: 'https://example.com/read',
          title: 'Newer read',
          published_at: 500,
          read: true,
        },
      ],
      { articles: 2 },
    );

    const afterRead = await getCachedArticles('reader');
    expect(afterRead.map((item) => item.id)).toEqual([
      'high-rank-older',
      'low-rank-newer',
    ]);
  });

  it('purges or updates cached articles when a feed is paused, cleared, or deleted', async () => {
    await cacheArticles('reader', [
      {
        id: 'feed-unread',
        feed_id: 'feed-1',
        url: 'https://example.com/1',
        title: 'Unread 1',
        read: false,
        saved: false,
      },
      {
        id: 'feed-saved',
        feed_id: 'feed-1',
        url: 'https://example.com/2',
        title: 'Saved 2',
        read: false,
        saved: true,
      },
    ]);

    await reconcileCachedFeed('reader', 'feed-1', { type: 'clear' });
    expect((await getCachedArticles('reader')).map((a) => a.id)).toEqual([
      'feed-saved',
    ]);

    await reconcileCachedFeed('reader', 'feed-1', { type: 'delete' });
    expect(await getCachedArticles('reader')).toEqual([]);
  });

  it('skips rewriting unchanged cached articles on repeat snapshot sync', async () => {
    const replaceSpy = vi.spyOn(memory, 'replaceRecords');
    const article = {
      id: 'unchanged-1',
      url: 'https://example.com/unchanged',
      title: 'Unchanged',
      summary: 'Summary',
      content: '<p>Full body</p>',
      read: false,
      saved: false,
    };

    await cacheArticles('reader', [article]);
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy.mock.calls[0][1]).toHaveLength(1);

    await cacheArticles('reader', [article]);
    expect(replaceSpy).toHaveBeenCalledTimes(2);
    expect(replaceSpy.mock.calls[1][1]).toHaveLength(0);
    expect(replaceSpy.mock.calls[1][2]).toHaveLength(0);
    replaceSpy.mockRestore();
  });
});
