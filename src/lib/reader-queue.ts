export const READER_QUEUE_STORAGE_KEY = 'feed-me-maybe:reader-queue';
export const DEFAULT_PREFETCH_THRESHOLD = 3;

const INTERNAL_ORIGIN = 'http://feed-me-maybe.local';

export type ArticlesQueuePagination = {
  kind: 'articles';
  hasMore: boolean;
  page: number;
  limit: number;
  removedCount: number;
  initialPage?: number;
  feedId?: string | null;
  params?: Record<string, string>;
};

export type SearchQueuePagination = {
  kind: 'search';
  nextCursor: string | null;
  query: string;
  sort?: 'relevance' | 'recent';
};

export type RecoveryQueuePagination = {
  kind: 'recovery';
  nextCursor: string | null;
  limit?: number;
  feedId?: string | null;
  kindFilter?: 'all' | 'hidden' | 'rejected';
};

export type ReaderQueuePagination =
  ArticlesQueuePagination | SearchQueuePagination | RecoveryQueuePagination;

export type ReaderQueue = {
  ids: string[];
  source: string;
  pagination?: ReaderQueuePagination | null;
};

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates an in-app stream origin (`from` query param or `reader-queue.source`).
 * Rejects external URLs, protocol-relative paths, backslashes, `/articles/` self-loops,
 * `/login`, and `/api/` endpoints.
 */
export function validateStreamOrigin(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    hasControlChars(value)
  ) {
    return null;
  }

  try {
    const target = new URL(value, INTERNAL_ORIGIN);
    if (
      target.origin !== INTERNAL_ORIGIN ||
      target.pathname.startsWith('//') ||
      target.pathname.includes('\\')
    ) {
      return null;
    }
    if (
      target.pathname === '/articles' ||
      target.pathname.startsWith('/articles/') ||
      target.pathname === '/login' ||
      target.pathname.startsWith('/login/') ||
      target.pathname === '/api' ||
      target.pathname.startsWith('/api/')
    ) {
      return null;
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

export function extractSameOriginReferrer(
  referrer: string | null | undefined,
  currentOrigin: string | null | undefined,
): string | null {
  if (!referrer || !currentOrigin) return null;
  try {
    const refUrl = new URL(referrer);
    if (refUrl.origin !== currentOrigin) return null;
    return validateStreamOrigin(`${refUrl.pathname}${refUrl.search}`);
  } catch {
    return null;
  }
}

export function resolveReaderReturnPath(options: {
  rawFrom: string | null | undefined;
  queueSource?: string | null;
  hasQueueMatch?: boolean;
  referrer?: string | null;
  currentOrigin?: string | null;
}): string {
  const { rawFrom } = options;
  if (rawFrom !== null && rawFrom !== undefined) {
    return validateStreamOrigin(rawFrom) ?? '/';
  }

  if (options.hasQueueMatch) {
    const validQueueSource = validateStreamOrigin(options.queueSource);
    if (validQueueSource) return validQueueSource;
  }

  const validReferrer = extractSameOriginReferrer(
    options.referrer,
    options.currentOrigin,
  );
  if (validReferrer) return validReferrer;

  return '/';
}

export function buildReaderArticleHref(
  articleId: string,
  options: { mode?: string | null; from?: string | null } = {},
): string {
  const params = new URLSearchParams();
  if (options.mode) {
    params.set('mode', options.mode);
  }
  const validFrom = validateStreamOrigin(options.from);
  if (validFrom) {
    params.set('from', validFrom);
  }
  const query = params.toString();
  return `/articles/${encodeURIComponent(articleId)}${query ? `?${query}` : ''}`;
}

export function deduplicateArticleIds(ids: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed || trimmed.length > 128 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function sanitizeStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const clean: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') {
      clean[key] = entry;
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      clean[key] = String(entry);
    }
  }
  return clean;
}

function normalizeQueuePagination(
  raw: unknown,
): ReaderQueuePagination | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  if (record.kind === 'articles') {
    const page =
      typeof record.page === 'number' && Number.isFinite(record.page)
        ? Math.max(1, Math.floor(record.page))
        : 1;
    const limit =
      typeof record.limit === 'number' && Number.isFinite(record.limit)
        ? Math.min(200, Math.max(1, Math.floor(record.limit)))
        : 25;
    const removedCount =
      typeof record.removedCount === 'number' &&
      Number.isFinite(record.removedCount)
        ? Math.max(0, Math.floor(record.removedCount))
        : 0;
    const initialPage =
      typeof record.initialPage === 'number' &&
      Number.isFinite(record.initialPage)
        ? Math.max(1, Math.floor(record.initialPage))
        : 1;
    return {
      kind: 'articles',
      hasMore: Boolean(record.hasMore),
      page,
      limit,
      removedCount,
      initialPage,
      feedId:
        typeof record.feedId === 'string' && record.feedId.trim()
          ? record.feedId.trim()
          : null,
      params: sanitizeStringRecord(record.params),
    };
  }

  if (record.kind === 'search') {
    const nextCursor =
      typeof record.nextCursor === 'string' && record.nextCursor.trim()
        ? record.nextCursor.trim()
        : null;
    const sort =
      record.sort === 'recent' || record.sort === 'relevance'
        ? record.sort
        : undefined;
    return {
      kind: 'search',
      nextCursor,
      query: typeof record.query === 'string' ? record.query : '',
      ...(sort ? { sort } : {}),
    };
  }

  if (record.kind === 'recovery') {
    const nextCursor =
      typeof record.nextCursor === 'string' && record.nextCursor.trim()
        ? record.nextCursor.trim()
        : null;
    const limit =
      typeof record.limit === 'number' && Number.isFinite(record.limit)
        ? Math.min(100, Math.max(1, Math.floor(record.limit)))
        : 50;
    const kindFilter =
      record.kindFilter === 'hidden' ||
      record.kindFilter === 'rejected' ||
      record.kindFilter === 'all'
        ? record.kindFilter
        : undefined;
    return {
      kind: 'recovery',
      nextCursor,
      limit,
      feedId:
        typeof record.feedId === 'string' && record.feedId.trim()
          ? record.feedId.trim()
          : null,
      ...(kindFilter ? { kindFilter } : {}),
    };
  }

  return null;
}

export function serializeReaderQueue(queue: ReaderQueue): string | null {
  const validSource = validateStreamOrigin(queue.source);
  if (!validSource) return null;
  const ids = deduplicateArticleIds(queue.ids);
  const pagination = normalizeQueuePagination(queue.pagination);
  return JSON.stringify({
    ids,
    source: validSource,
    ...(pagination ? { pagination } : { pagination: null }),
  });
}

/**
 * Parses and validates `feed-me-maybe:reader-queue` from `sessionStorage`.
 * Rejects malformed queues, queues that do not contain `articleId`, and stale
 * queues whose `source` does not match the active `from` stream origin.
 */
export function parseStoredReaderQueue(
  raw: string | null | undefined,
  context: {
    articleId: string;
    rawFrom: string | null | undefined;
    referrer?: string | null;
    currentOrigin?: string | null;
  },
): ReaderQueue | null {
  if (!raw || !context.articleId) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.ids)) return null;
  const ids = deduplicateArticleIds(record.ids);
  if (!ids.includes(context.articleId)) return null;

  const source = validateStreamOrigin(record.source);
  if (!source) return null;

  if (context.rawFrom !== null && context.rawFrom !== undefined) {
    const validFrom = validateStreamOrigin(context.rawFrom);
    if (!validFrom || validFrom !== source) {
      return null;
    }
  } else {
    const referrerOrigin = extractSameOriginReferrer(
      context.referrer,
      context.currentOrigin,
    );
    if (!referrerOrigin || referrerOrigin !== source) {
      return null;
    }
  }

  return {
    ids,
    source,
    pagination: normalizeQueuePagination(record.pagination),
  };
}

export function queueCanLoadMore(
  queue: ReaderQueue | null | undefined,
): boolean {
  const pagination = queue?.pagination;
  if (!pagination) return false;
  if (pagination.kind === 'articles') {
    return pagination.hasMore;
  }
  return Boolean(pagination.nextCursor);
}

export function countRemainingQueueItems(
  queue: ReaderQueue | null | undefined,
  currentArticleId: string,
  dismissedIds: readonly string[] = [],
): number {
  if (!queue) return 0;
  const index = queue.ids.indexOf(currentArticleId);
  if (index < 0) return 0;
  const dismissed = new Set(dismissedIds);
  let remaining = 0;
  for (let i = index + 1; i < queue.ids.length; i += 1) {
    if (!dismissed.has(queue.ids[i])) {
      remaining += 1;
    }
  }
  return remaining;
}

export function shouldPrefetchReaderQueue(
  queue: ReaderQueue | null | undefined,
  currentArticleId: string,
  dismissedIds: readonly string[] = [],
  threshold = DEFAULT_PREFETCH_THRESHOLD,
): boolean {
  if (!queue || !queueCanLoadMore(queue)) return false;
  if (!queue.ids.includes(currentArticleId)) return false;
  return (
    countRemainingQueueItems(queue, currentArticleId, dismissedIds) <= threshold
  );
}

export function getPaginationAttemptKey(
  queue: ReaderQueue | null | undefined,
): string | null {
  const pagination = queue?.pagination;
  if (!queue || !pagination || !queueCanLoadMore(queue)) return null;
  if (pagination.kind === 'articles') {
    return `${queue.source}|articles|${pagination.page}|${queue.ids.length}`;
  }
  return `${queue.source}|${pagination.kind}|${pagination.nextCursor ?? ''}`;
}

export function buildQueueNextPageRequest(
  queue: ReaderQueue,
  dismissedIds: readonly string[] = [],
): string | null {
  const pagination = queue.pagination;
  if (!pagination || !queueCanLoadMore(queue)) return null;

  if (pagination.kind === 'articles') {
    const params = new URLSearchParams();
    const nextPage = pagination.page + 1;
    const dismissed = new Set(dismissedIds);
    const activeIds = queue.ids.filter((id) => !dismissed.has(id));
    const excludeSlice = activeIds.slice(-200);
    const initialOffset =
      ((pagination.initialPage ?? 1) - 1) * pagination.limit;
    const computedOffset =
      activeIds.length <= 200
        ? initialOffset + excludeSlice.length
        : Math.max(
            0,
            initialOffset +
              pagination.page * pagination.limit -
              pagination.removedCount -
              dismissed.size,
          );

    params.set('page', String(nextPage));
    params.set('offset', String(computedOffset));
    params.set('limit', String(pagination.limit));
    if (pagination.feedId) {
      params.set('feedId', pagination.feedId);
    }
    if (pagination.params) {
      for (const [key, value] of Object.entries(pagination.params)) {
        params.set(key, value);
      }
    }
    if (excludeSlice.length > 0) {
      params.set('excludeIds', excludeSlice.join(','));
    }
    return `/api/articles?${params.toString()}`;
  }

  if (pagination.kind === 'search') {
    if (!pagination.nextCursor) return null;
    const params = new URLSearchParams();
    if (pagination.query) {
      params.set('q', pagination.query);
    }
    params.set('cursor', pagination.nextCursor);
    if (pagination.sort === 'recent') {
      params.set('sort', 'recent');
    }
    return `/api/search?${params.toString()}`;
  }

  if (pagination.kind === 'recovery') {
    if (!pagination.nextCursor) return null;
    const params = new URLSearchParams();
    params.set('limit', String(pagination.limit ?? 50));
    params.set('cursor', pagination.nextCursor);
    if (pagination.feedId) {
      params.set('feedId', pagination.feedId);
    }
    if (pagination.kindFilter && pagination.kindFilter !== 'all') {
      params.set('kind', pagination.kindFilter);
    }
    return `/api/article-state/recovery?${params.toString()}`;
  }

  return null;
}

export function applyQueuePageResponse(
  queue: ReaderQueue,
  payload: unknown,
  dismissedIds: readonly string[] = [],
): ReaderQueue {
  const pagination = queue.pagination;
  if (!pagination) return queue;

  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const rawArticles = Array.isArray(record.articles) ? record.articles : [];
  const rawIds = rawArticles.map((item) =>
    item && typeof item === 'object'
      ? ((item as Record<string, unknown>).id as unknown)
      : undefined,
  );
  const incomingIds = deduplicateArticleIds(rawIds);

  const existingSet = new Set([...queue.ids, ...dismissedIds]);
  const appendedIds = incomingIds.filter((id) => !existingSet.has(id));
  const mergedIds = [...queue.ids, ...appendedIds];

  if (pagination.kind === 'articles') {
    const hasMore =
      rawArticles.length >= pagination.limit && appendedIds.length > 0;
    return {
      ...queue,
      ids: mergedIds,
      pagination: {
        ...pagination,
        page: rawArticles.length > 0 ? pagination.page + 1 : pagination.page,
        hasMore,
      },
    };
  }

  const rawNextCursor =
    typeof record.nextCursor === 'string' && record.nextCursor.trim()
      ? record.nextCursor.trim()
      : null;
  const nextCursor =
    rawNextCursor &&
    rawNextCursor !== pagination.nextCursor &&
    rawArticles.length > 0
      ? rawNextCursor
      : null;

  return {
    ...queue,
    ids: mergedIds,
    pagination: {
      ...pagination,
      nextCursor,
    },
  };
}
