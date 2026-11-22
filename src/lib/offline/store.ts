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
import { applyMutationToArticle, matchesOfflineVisibility } from './state';
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

  if (previousScope !== scope) {
    await putMetaValue(ACTIVE_SCOPE_KEY, scope);
    await putMetaValue('cache-version', OFFLINE_CACHE_VERSION);
  }
  return scope;
}

export async function activateOfflineUser(userScope: string): Promise<string> {
  return serialize(() => activateOfflineUserInternal(userScope));
}

function preserveArticleContent(
  incomingContent: string | null | undefined,
  previousContent: string | null | undefined,
): string | null | undefined {
  if (typeof incomingContent === 'string' && incomingContent.length > 0) {
    if (
      typeof previousContent === 'string' &&
      previousContent.length > incomingContent.length
    ) {
      return previousContent;
    }
    return incomingContent;
  }
  return previousContent ?? incomingContent;
}

function makeCachedArticle(
  scope: string,
  article: OfflineArticle,
  previous?: CachedArticle,
): CachedArticle {
  const timestamp = now();
  const normalized = normalizeArticleFlags(article);
  const candidate: CachedArticle = {
    ...normalized,
    cacheVersion: OFFLINE_CACHE_VERSION,
    scope,
    key: scopedKey(scope, article.id),
    cachedAt: previous?.cachedAt ?? timestamp,
    updatedAt: timestamp,
  };
  if (previous && !hasCachedArticleChanged(previous, candidate)) {
    return previous;
  }
  return candidate;
}

function hasCachedArticleChanged(
  previous: CachedArticle,
  next: CachedArticle,
): boolean {
  return (
    previous.id !== next.id ||
    previous.url !== next.url ||
    previous.title !== next.title ||
    (previous.author ?? null) !== (next.author ?? null) ||
    (previous.summary ?? null) !== (next.summary ?? null) ||
    (previous.content ?? null) !== (next.content ?? null) ||
    (previous.image_url ?? null) !== (next.image_url ?? null) ||
    (previous.published_at ?? null) !== (next.published_at ?? null) ||
    (previous.fetched_at ?? null) !== (next.fetched_at ?? null) ||
    (previous.feed_id ?? null) !== (next.feed_id ?? null) ||
    (previous.feed_title ?? null) !== (next.feed_title ?? null) ||
    (previous.feed_url ?? null) !== (next.feed_url ?? null) ||
    (previous.feed_site_url ?? null) !== (next.feed_site_url ?? null) ||
    (previous.feed_open_mode ?? null) !== (next.feed_open_mode ?? null) ||
    (previous.feed_enabled ?? null) !== (next.feed_enabled ?? null) ||
    (previous.cleared_at ?? null) !== (next.cleared_at ?? null) ||
    Boolean(previous.read) !== Boolean(next.read) ||
    Boolean(previous.saved) !== Boolean(next.saved) ||
    Boolean(previous.hidden) !== Boolean(next.hidden) ||
    Boolean(previous.thumbs_up) !== Boolean(next.thumbs_up) ||
    Boolean(previous.thumbs_down) !== Boolean(next.thumbs_down) ||
    (previous.heuristic_score ?? null) !== (next.heuristic_score ?? null) ||
    (previous.combined_score ?? null) !== (next.combined_score ?? null) ||
    (previous.offline_rank_score ?? null) !== (next.offline_rank_score ?? null)
  );
}

function normalizeArticleFlags<T extends OfflineArticle>(article: T): T {
  return {
    ...article,
    ...(article.feed_enabled !== undefined && article.feed_enabled !== null
      ? { feed_enabled: Boolean(article.feed_enabled) }
      : {}),
    read: Boolean(article.read),
    saved: Boolean(article.saved),
    hidden: Boolean(article.hidden),
    thumbs_up: Boolean(article.thumbs_up),
    thumbs_down: Boolean(article.thumbs_down),
  };
}

function getArticleRankScore(article: OfflineArticle): number | null {
  if (
    typeof article.offline_rank_score === 'number' &&
    Number.isFinite(article.offline_rank_score)
  ) {
    return article.offline_rank_score;
  }
  if (
    typeof article.combined_score === 'number' &&
    Number.isFinite(article.combined_score) &&
    article.combined_score > 0
  ) {
    return article.combined_score;
  }
  if (
    typeof article.heuristic_score === 'number' &&
    Number.isFinite(article.heuristic_score)
  ) {
    return article.heuristic_score;
  }
  return null;
}

function sortArticles(a: CachedArticle, b: CachedArticle): number {
  const aScore = getArticleRankScore(a);
  const bScore = getArticleRankScore(b);
  if (aScore !== null || bScore !== null) {
    const aUnread = !a.read && matchesOfflineVisibility(a) ? 1 : 0;
    const bUnread = !b.read && matchesOfflineVisibility(b) ? 1 : 0;
    if (aUnread !== bUnread) return bUnread - aUnread;
    const scoreDiff = (bScore ?? -Infinity) - (aScore ?? -Infinity);
    if (scoreDiff !== 0) return scoreDiff;
  }
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
  protectedSavedKeys: Set<string> = new Set(),
): CachedArticle[] {
  const savedArticles = records
    .filter((article) => article.saved === true)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const protectedSaved = savedArticles.filter((article) =>
    protectedSavedKeys.has(article.key),
  );
  const otherSaved = savedArticles
    .filter((article) => !protectedSavedKeys.has(article.key))
    .slice(0, Math.max(0, limits.savedArticles - protectedSaved.length));
  const saved = [...protectedSaved, ...otherSaved];
  const savedKeys = new Set(saved.map((article) => article.key));
  const nonSaved = records.filter((article) => !savedKeys.has(article.key));
  const unreadVisible = nonSaved
    .filter((article) => !article.read && matchesOfflineVisibility(article))
    .sort(sortArticles);
  const restNonSaved = nonSaved
    .filter((article) => article.read || !matchesOfflineVisibility(article))
    .sort(sortArticles);
  const recent = [...unreadVisible, ...restNonSaved].slice(0, limits.articles);
  return [...saved, ...recent];
}

function getPendingSaveKeys(
  scope: string,
  mutations: OfflineMutation[],
): Set<string> {
  const latestByArticle = new Map<string, OfflineMutation>();
  for (const mutation of mutations
    .filter(
      (candidate) =>
        candidate.scope === scope &&
        (candidate.type === 'save' || candidate.type === 'unsave'),
    )
    .sort((a, b) => a.sequence - b.sequence)) {
    latestByArticle.set(mutation.articleId, mutation);
  }
  return new Set(
    [...latestByArticle.values()]
      .filter((mutation) => mutation.type === 'save')
      .map((mutation) => scopedKey(scope, mutation.articleId)),
  );
}

async function getScopedArticles(scope: string): Promise<CachedArticle[]> {
  const records = await getAllRecords<CachedArticle>('articles');
  return records
    .filter(
      (article) =>
        article.scope === scope &&
        article.cacheVersion === OFFLINE_CACHE_VERSION,
    )
    .map(normalizeArticleFlags);
}

async function commitArticleChanges(
  existing: CachedArticle[],
  kept: CachedArticle[],
): Promise<void> {
  const existingByKey = new Map(
    existing.map((article) => [article.key, article]),
  );
  const keptKeys = new Set(kept.map((article) => article.key));
  const deleteKeys = existing
    .filter((article) => !keptKeys.has(article.key))
    .map((article) => article.key);
  const changedRecords = kept.filter((article) => {
    const previous = existingByKey.get(article.key);
    return !previous || hasCachedArticleChanged(previous, article);
  });
  await replaceRecords('articles', changedRecords, deleteKeys);
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
    const pendingSaveKeys = getPendingSaveKeys(scope, pending);
    const merged = new Map(existing.map((article) => [article.key, article]));
    for (const article of articles) {
      if (article.id) {
        const key = scopedKey(scope, article.id);
        const previous = merged.get(key);
        const withLocalIntent = applyPendingIntent(
          scope,
          {
            ...previous,
            ...article,
            content: preserveArticleContent(article.content, previous?.content),
          },
          pending,
        );
        merged.set(key, makeCachedArticle(scope, withLocalIntent, previous));
      }
    }
    const kept = trimArticles(
      [...merged.values()],
      normalizeLimits(limits),
      pendingSaveKeys,
    );
    await commitArticleChanges(existing, kept);
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
    const pendingSaveKeys = getPendingSaveKeys(scope, pending);
    const incomingIds = new Set(articles.map((article) => article.id));
    const retained = existing
      .map((article) =>
        makeCachedArticle(
          scope,
          applyPendingIntent(scope, article, pending),
          article,
        ),
      )
      .filter(
        (article) =>
          article.saved !== true ||
          incomingIds.has(article.id) ||
          pendingSaveKeys.has(article.key),
      );
    const merged = new Map(retained.map((article) => [article.key, article]));
    const incoming = articles.map((article) => {
      const key = scopedKey(scope, article.id);
      const previous = merged.get(key);
      const withLocalIntent = applyPendingIntent(
        scope,
        {
          ...previous,
          ...article,
          content: preserveArticleContent(article.content, previous?.content),
          saved: true,
        },
        pending,
      );
      return makeCachedArticle(scope, withLocalIntent, previous);
    });
    for (const article of incoming) merged.set(article.key, article);
    const kept = trimArticles(
      [...merged.values()],
      normalizeLimits(limits),
      pendingSaveKeys,
    );
    await commitArticleChanges(existing, kept);
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

export async function cacheOfflineSnapshot(
  userScope: string,
  snapshot: OfflineLibrarySnapshot,
  limits: OfflineStorageLimits = {},
): Promise<void> {
  await serialize(async () => {
    const scope = await activateOfflineUserInternal(userScope);
    const existing = await getScopedArticles(scope);
    const pending = await getAllRecords<OfflineMutation>('outbox');
    const pendingSaveKeys = getPendingSaveKeys(scope, pending);
    const pendingArticleKeys = new Set(
      pending
        .filter((mutation) => mutation.scope === scope)
        .map((mutation) => scopedKey(scope, mutation.articleId)),
    );
    const existingByKey = new Map(
      existing.map((article) => [article.key, article]),
    );
    const reconciled = new Map<string, CachedArticle>();

    const incomingArticles = [
      ...(snapshot.articles ?? []),
      ...(snapshot.savedArticles ?? []).map((article) => ({
        ...article,
        saved: true,
      })),
    ];

    for (const article of incomingArticles) {
      if (!article.id) continue;
      const key = scopedKey(scope, article.id);
      const previous = reconciled.get(key) ?? existingByKey.get(key);
      const withLocalIntent = applyPendingIntent(
        scope,
        {
          ...previous,
          ...article,
          content: preserveArticleContent(article.content, previous?.content),
        },
        pending,
      );
      reconciled.set(
        key,
        makeCachedArticle(scope, withLocalIntent, existingByKey.get(key)),
      );
    }

    for (const previous of existing) {
      if (reconciled.has(previous.key)) continue;
      if (
        pendingSaveKeys.has(previous.key) ||
        pendingArticleKeys.has(previous.key)
      ) {
        const withLocalIntent = applyPendingIntent(
          scope,
          {
            ...previous,
            saved: pendingSaveKeys.has(previous.key),
          },
          pending,
        );
        reconciled.set(
          previous.key,
          makeCachedArticle(scope, withLocalIntent, previous),
        );
      }
    }

    const kept = trimArticles(
      [...reconciled.values()],
      normalizeLimits(limits),
      pendingSaveKeys,
    );
    await commitArticleChanges(existing, kept);
  });

  for (const digest of snapshot.digests ?? []) {
    await cacheDigest(userScope, digest, limits);
  }
}

export async function reconcileCachedFeed(
  userScope: string,
  feedId: string,
  action:
    | { type: 'delete' }
    | { type: 'clear' }
    | {
        type: 'update';
        enabled: boolean;
        title?: string | null;
        openMode?: string | null;
      },
): Promise<void> {
  return serialize(async () => {
    const scope = normalizeOfflineScope(userScope);
    const existing = await getScopedArticles(scope);
    const updated: CachedArticle[] = [];

    for (const article of existing) {
      if (article.feed_id !== feedId) {
        updated.push(article);
        continue;
      }
      if (action.type === 'delete') {
        continue;
      }
      if (action.type === 'clear') {
        if (article.saved === true) {
          updated.push(article);
        }
        continue;
      }
      if (action.type !== 'update') continue;
      if (!action.enabled && article.saved !== true) {
        continue;
      }
      updated.push(
        makeCachedArticle(
          scope,
          {
            ...article,
            feed_enabled: action.enabled,
            ...(action.title !== undefined ? { feed_title: action.title } : {}),
            ...(action.openMode !== undefined
              ? { feed_open_mode: action.openMode }
              : {}),
          },
          article,
        ),
      );
    }

    await commitArticleChanges(existing, updated);
  });
}

function isOfflineArticle(value: unknown): value is OfflineArticle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const article = value as Partial<OfflineArticle>;
  return (
    typeof article.id === 'string' &&
    typeof article.url === 'string' &&
    typeof article.title === 'string'
  );
}

/** Refresh bounded private article bodies from an authenticated, no-store API. */
export async function refreshOfflineArticleBodies(
  userScope: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return false;
  }

  const response = await fetchImpl('/api/offline/articles', {
    credentials: 'include',
    cache: 'no-store',
    ...(typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
      ? { signal: AbortSignal.timeout(15_000) }
      : {}),
  });
  if (!response.ok) return false;

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const snapshot = payload as {
    articles?: unknown;
    savedArticles?: unknown;
  };
  if (
    !Array.isArray(snapshot.articles) ||
    !Array.isArray(snapshot.savedArticles)
  ) {
    return false;
  }

  await cacheOfflineSnapshot(userScope, {
    articles: snapshot.articles.filter(isOfflineArticle),
    savedArticles: snapshot.savedArticles.filter(isOfflineArticle),
  });
  return true;
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
      article,
    );
    if (updated === article) return;
    await putRecords('articles', [updated]);
  });
}

export async function clearOfflinePrivateData(): Promise<void> {
  return serialize(async () => {
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
