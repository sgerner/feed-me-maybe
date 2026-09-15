import {
  clearOfflineStores,
  getAllRecords,
  getMetaValue,
  normalizeOfflineScope,
  putMetaValue,
  putRecords,
  replaceRecords,
  scopedKey,
} from './db';
import { applyMutationToArticle } from './state';
import {
  DEFAULT_OFFLINE_LIMITS,
  OFFLINE_CACHE_VERSION,
  type CachedArticle,
  type CachedDigest,
  type OfflineArticle,
  type OfflineDigest,
  type OfflineMutation,
  type OfflineMutationType,
  type OfflineLibrarySnapshot,
  type OfflineStorageLimits,
} from './types';

const ACTIVE_SCOPE_KEY = 'active-scope';

let activeScope: string | null = null;
let operationQueue: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function now(): number {
  return Date.now();
}

function normalizeLimits(limits: OfflineStorageLimits = {}) {
  return {
    articles: Math.max(
      0,
      Math.floor(limits.articles ?? DEFAULT_OFFLINE_LIMITS.articles),
    ),
    savedArticles: Math.max(
      0,
      Math.floor(limits.savedArticles ?? DEFAULT_OFFLINE_LIMITS.savedArticles),
    ),
    digests: Math.max(
      0,
      Math.floor(limits.digests ?? DEFAULT_OFFLINE_LIMITS.digests),
    ),
  };
}

async function activateOfflineUserInternal(userScope: string): Promise<string> {
  const scope = normalizeOfflineScope(userScope);
  const previousScope = await getMetaValue(ACTIVE_SCOPE_KEY);

  // Account switches are a hard privacy boundary. A single-origin PWA must
  // not leave the previous account's articles available to the next one.
  if (previousScope !== undefined && previousScope !== scope) {
    await clearOfflineStores();
  }

  await putMetaValue(ACTIVE_SCOPE_KEY, scope);
  await putMetaValue('cache-version', OFFLINE_CACHE_VERSION);
  activeScope = scope;
  return scope;
}

export async function activateOfflineUser(userScope: string): Promise<string> {
  return serialize(() => activateOfflineUserInternal(userScope));
}

export function getActiveOfflineScope(): string | null {
  return activeScope;
}

function makeCachedArticle(
  scope: string,
  article: OfflineArticle,
): CachedArticle {
  const timestamp = now();
  return {
    ...article,
    cacheVersion: OFFLINE_CACHE_VERSION,
    scope,
    key: scopedKey(scope, article.id),
    cachedAt: timestamp,
    updatedAt: timestamp,
  };
}

function sortArticles(a: CachedArticle, b: CachedArticle): number {
  const aDate = a.published_at ?? a.fetched_at ?? a.updatedAt;
  const bDate = b.published_at ?? b.fetched_at ?? b.updatedAt;
  return bDate - aDate || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

function applyPendingIntent(
  scope: string,
  article: OfflineArticle,
  mutations: OfflineMutation[],
): OfflineArticle {
  return mutations
    .filter(
      (mutation) =>
        mutation.scope === scope && mutation.articleId === article.id,
    )
    .sort((a, b) => a.sequence - b.sequence)
    .reduce(
      (current, mutation) => applyMutationToArticle(current, mutation.type),
      article,
    );
}

function trimArticles(
  records: CachedArticle[],
  limits: ReturnType<typeof normalizeLimits>,
): CachedArticle[] {
  const saved = records
    .filter((article) => article.saved === true)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limits.savedArticles);
  const savedKeys = new Set(saved.map((article) => article.key));
  const recent = records
    .filter((article) => !savedKeys.has(article.key))
    .sort(sortArticles)
    .slice(0, limits.articles);
  return [...saved, ...recent];
}

async function getScopedArticles(scope: string): Promise<CachedArticle[]> {
  const records = await getAllRecords<CachedArticle>('articles');
  return records.filter(
    (article) =>
      article.scope === scope && article.cacheVersion === OFFLINE_CACHE_VERSION,
  );
}

export async function cacheArticles(
  userScope: string,
  articles: OfflineArticle[],
  limits: OfflineStorageLimits = {},
): Promise<void> {
  return serialize(async () => {
    const scope = await activateOfflineUserInternal(userScope);
    const existing = await getScopedArticles(scope);
    const pending = await getAllRecords<OfflineMutation>('outbox');
    const merged = new Map(existing.map((article) => [article.key, article]));
    for (const article of articles) {
      if (article.id) {
        const withLocalIntent = applyPendingIntent(scope, article, pending);
        merged.set(
          scopedKey(scope, article.id),
          makeCachedArticle(scope, withLocalIntent),
        );
      }
    }
    const kept = trimArticles([...merged.values()], normalizeLimits(limits));
    const keptKeys = new Set(kept.map((article) => article.key));
    const deleteKeys = existing
      .filter((article) => !keptKeys.has(article.key))
      .map((article) => article.key);
    await replaceRecords('articles', kept, deleteKeys);
  });
}

export async function cacheSavedArticles(
  userScope: string,
  articles: OfflineArticle[],
  limits: OfflineStorageLimits = {},
): Promise<void> {
  return serialize(async () => {
    const scope = await activateOfflineUserInternal(userScope);
    const existing = await getScopedArticles(scope);
    const pending = await getAllRecords<OfflineMutation>('outbox');
    const incomingIds = new Set(articles.map((article) => article.id));
    const retained = existing.filter(
      (article) => article.saved !== true || incomingIds.has(article.id),
    );
    const incoming = articles.map((article) => {
      const withLocalIntent = applyPendingIntent(
        scope,
        { ...article, saved: true },
        pending,
      );
      return makeCachedArticle(scope, withLocalIntent);
    });
    const merged = new Map(retained.map((article) => [article.key, article]));
    for (const article of incoming) merged.set(article.key, article);
    const kept = trimArticles([...merged.values()], normalizeLimits(limits));
    const keptKeys = new Set(kept.map((article) => article.key));
    const deleteKeys = existing
      .filter((article) => !keptKeys.has(article.key))
      .map((article) => article.key);
    await replaceRecords('articles', kept, deleteKeys);
  });
}

export async function getCachedArticles(
  userScope: string,
  options: { savedOnly?: boolean; limit?: number } = {},
): Promise<CachedArticle[]> {
  const scope = normalizeOfflineScope(userScope);
  const articles = (await getScopedArticles(scope))
    .filter((article) => !options.savedOnly || article.saved === true)
    .sort(sortArticles);
  return options.limit === undefined
    ? articles
    : articles.slice(0, Math.max(0, options.limit));
}

export async function getCachedSavedArticles(
  userScope: string,
  limit?: number,
): Promise<CachedArticle[]> {
  return getCachedArticles(userScope, { savedOnly: true, limit });
}

function makeCachedDigest(scope: string, digest: OfflineDigest): CachedDigest {
  const timestamp = now();
  return {
    ...digest,
    cacheVersion: OFFLINE_CACHE_VERSION,
    scope,
    key: scopedKey(scope, digest.id),
    cachedAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function cacheDigest(
  userScope: string,
  digest: OfflineDigest,
  limits: OfflineStorageLimits = {},
): Promise<void> {
  return serialize(async () => {
    const scope = await activateOfflineUserInternal(userScope);
    const existing = (await getAllRecords<CachedDigest>('digests')).filter(
      (item) =>
        item.scope === scope && item.cacheVersion === OFFLINE_CACHE_VERSION,
    );
    const merged = new Map(existing.map((item) => [item.key, item]));
    merged.set(scopedKey(scope, digest.id), makeCachedDigest(scope, digest));
    const kept = [...merged.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, normalizeLimits(limits).digests);
    const keptKeys = new Set(kept.map((item) => item.key));
    const deleteKeys = existing
      .filter((item) => !keptKeys.has(item.key))
      .map((item) => item.key);
    await replaceRecords('digests', kept, deleteKeys);
  });
}

export async function getCachedDigests(
  userScope: string,
  limit?: number,
): Promise<CachedDigest[]> {
  const scope = normalizeOfflineScope(userScope);
  const digests = (await getAllRecords<CachedDigest>('digests'))
    .filter(
      (item) =>
        item.scope === scope && item.cacheVersion === OFFLINE_CACHE_VERSION,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return limit === undefined ? digests : digests.slice(0, Math.max(0, limit));
}

export async function getCachedDigest(
  userScope: string,
  digestId: string,
): Promise<CachedDigest | undefined> {
  const digests = await getCachedDigests(userScope);
  return digests.find((digest) => digest.id === digestId);
}

export async function cacheOfflineSnapshot(
  userScope: string,
  snapshot: OfflineLibrarySnapshot,
  limits: OfflineStorageLimits = {},
): Promise<void> {
  await cacheArticles(userScope, snapshot.articles ?? [], limits);
  if (snapshot.savedArticles) {
    await cacheSavedArticles(userScope, snapshot.savedArticles, limits);
  }
  for (const digest of snapshot.digests ?? []) {
    await cacheDigest(userScope, digest, limits);
  }
}

export async function applyMutationToCachedArticle(
  userScope: string,
  articleId: string,
  type: OfflineMutationType,
): Promise<void> {
  return serialize(async () => {
    const scope = normalizeOfflineScope(userScope);
    const articles = await getScopedArticles(scope);
    const article = articles.find((item) => item.id === articleId);
    if (!article) return;
    const updated = makeCachedArticle(
      scope,
      applyMutationToArticle(article, type),
    );
    await putRecords('articles', [updated]);
  });
}

export async function clearOfflinePrivateData(): Promise<void> {
  return serialize(async () => {
    activeScope = null;
    await clearOfflineStores();

    if (
      typeof navigator !== 'undefined' &&
      navigator.serviceWorker?.controller
    ) {
      navigator.serviceWorker.controller.postMessage({
        type: 'FEED_ME_MAYBE_CLEAR_PRIVATE_DATA',
      });
    }
  });
}

export async function getOfflineStorageCounts(userScope: string): Promise<{
  articles: number;
  savedArticles: number;
  digests: number;
  outbox: number;
}> {
  const scope = normalizeOfflineScope(userScope);
  const [articles, digests, outbox] = await Promise.all([
    getScopedArticles(scope),
    getAllRecords<CachedDigest>('digests'),
    getAllRecords<OfflineMutation>('outbox'),
  ]);
  return {
    articles: articles.filter((article) => article.saved !== true).length,
    savedArticles: articles.filter((article) => article.saved === true).length,
    digests: digests.filter(
      (digest) =>
        digest.scope === scope && digest.cacheVersion === OFFLINE_CACHE_VERSION,
    ).length,
    outbox: outbox.filter((mutation) => mutation.scope === scope).length,
  };
}

export { ACTIVE_SCOPE_KEY, normalizeOfflineScope };
