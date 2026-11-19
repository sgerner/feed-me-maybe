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

import { cacheSavedArticles, getCachedSavedArticles } from './store';
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
});
