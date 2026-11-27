export type LiveArticleCandidate = {
  id: string;
  fetched_at?: number | null;
};

/**
 * Extracts valid live-update article IDs from an incoming event payload while
 * ignoring broadcasts scoped to a different feed when viewing a single feed.
 */
export function extractLiveArticleIds(
  detail: { ids?: unknown; feedId?: unknown } | null | undefined,
  targetFeedId?: string | null,
): string[] {
  if (!Array.isArray(detail?.ids)) return [];
  if (
    targetFeedId &&
    typeof detail.feedId === 'string' &&
    detail.feedId.length > 0 &&
    detail.feedId !== targetFeedId
  ) {
    return [];
  }

  const validIds: string[] = [];
  for (const id of detail.ids) {
    if (typeof id === 'string' && id.length > 0 && id.length <= 128) {
      validIds.push(id);
    }
  }
  return validIds;
}

/**
 * Prepends newly fetched live articles onto the current stream without
 * duplicating existing items, tracking post-snapshot IDs and keeping keyboard
 * focus anchored when articles are inserted above the active card.
 */
export function mergeLiveArticles<T extends LiveArticleCandidate>(options: {
  existingArticles: T[];
  incomingArticles: T[];
  snapshotAt?: number;
  focusedIndex: number;
  preserveFocusedArticle?: boolean;
}): {
  articles: T[];
  newArticles: T[];
  addedAfterSnapshot: string[];
  focusedIndex: number;
} {
  const {
    existingArticles,
    incomingArticles,
    snapshotAt,
    focusedIndex,
    preserveFocusedArticle = false,
  } = options;

  const seenIds = new Set(existingArticles.map((article) => article.id));
  const newArticles: T[] = [];
  for (const article of incomingArticles) {
    if (seenIds.has(article.id)) continue;
    seenIds.add(article.id);
    newArticles.push(article);
  }

  if (newArticles.length === 0) {
    return {
      articles: existingArticles,
      newArticles: [],
      addedAfterSnapshot: [],
      focusedIndex,
    };
  }

  const addedAfterSnapshot: string[] = [];
  if (typeof snapshotAt === 'number' && Number.isFinite(snapshotAt)) {
    for (const article of newArticles) {
      if (
        typeof article.fetched_at === 'number' &&
        article.fetched_at > snapshotAt
      ) {
        addedAfterSnapshot.push(article.id);
      }
    }
  }

  const nextFocusedIndex =
    existingArticles.length > 0 && preserveFocusedArticle
      ? focusedIndex + newArticles.length
      : focusedIndex;

  return {
    articles: [...newArticles, ...existingArticles],
    newArticles,
    addedAfterSnapshot,
    focusedIndex: nextFocusedIndex,
  };
}
