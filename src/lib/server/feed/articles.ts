import { getDb } from '#lib/server/db/index.ts';
import {
  parseArticleSort,
  rankingOrderExpression,
  type ArticleSort,
} from '#lib/server/ranking.ts';

export const HIDDEN_FEED_CONTENT_LIMIT = 30;
export const DEFAULT_FEED_PAGE_LIMIT = 25;

export type FeedArticleRow = {
  id: string;
  feed_id: string;
  url: string;
  title: string;
  author: string | null;
  summary: string | null;
  image_url: string | null;
  categories: string | null;
  published_at: number | null;
  fetched_at: number | null;
  read: number;
  saved: number;
  hidden: number;
  thumbs_up: number;
  thumbs_down: number;
  heuristic_score: number | null;
  combined_score: number | null;
  feed_title: string | null;
  feed_url: string | null;
  feed_open_mode: string | null;
};

export type FeedArticlesQueryResult = {
  articles: FeedArticleRow[];
  page: number;
  totalPages: number;
  totalArticles: number;
  hiddenContentLimit: number | null;
};

type FeedArticlesQueryOptions = {
  feedId: string;
  page?: number;
  limit?: number;
  offset?: number;
  showHiddenContent?: boolean;
  unreadOnly?: boolean;
  sort?: ArticleSort;
  snapshotAt?: number;
  excludeIds?: string[];
};

function buildAutoHiddenWhereClause(alias: string): string {
  return `
    ${alias}.hidden = 1
    AND EXISTS (
      SELECT 1
      FROM user_interactions ui
      WHERE ui.article_id = ${alias}.id
        AND ui.interaction_type = 'hide'
        AND json_extract(CASE WHEN json_valid(ui.metadata) THEN ui.metadata ELSE '{}' END, '$.auto') = 1
        AND json_extract(CASE WHEN json_valid(ui.metadata) THEN ui.metadata ELSE '{}' END, '$.reason') = 'preference_model'
        AND COALESCE(json_extract(CASE WHEN json_valid(ui.metadata) THEN ui.metadata ELSE '{}' END, '$.undone_at'), 0) = 0
    )
    AND NOT EXISTS (
      SELECT 1
      FROM user_interactions ui
      WHERE ui.article_id = ${alias}.id
        AND ui.interaction_type = 'hide'
        AND COALESCE(json_extract(CASE WHEN json_valid(ui.metadata) THEN ui.metadata ELSE '{}' END, '$.undone_at'), 0) = 0
        AND (
          json_extract(CASE WHEN json_valid(ui.metadata) THEN ui.metadata ELSE '{}' END, '$.auto') IS NULL
          OR json_extract(CASE WHEN json_valid(ui.metadata) THEN ui.metadata ELSE '{}' END, '$.reason') IS NULL
          OR json_extract(CASE WHEN json_valid(ui.metadata) THEN ui.metadata ELSE '{}' END, '$.reason') != 'preference_model'
        )
    )
  `;
}

function buildFeedArticleSelect(): string {
  return `
    SELECT a.id, a.feed_id, a.url, a.title, a.author, a.summary, a.image_url, a.categories,
           a.published_at, a.fetched_at, a.read, a.saved, a.hidden, a.thumbs_up, a.thumbs_down,
           a.heuristic_score, a.combined_score,
           f.title as feed_title, f.url as feed_url, f.open_mode as feed_open_mode
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id
  `;
}

export function getFeedArticles(
  options: FeedArticlesQueryOptions,
): FeedArticlesQueryResult {
  const db = getDb();
  const page = Math.max(1, Math.floor(options.page || 1));

  if (options.showHiddenContent) {
    const countResult = db
      .prepare(
        `
        SELECT COUNT(*) as count
        FROM articles a
        WHERE a.feed_id = ?
          AND ${buildAutoHiddenWhereClause('a')}
      `,
      )
      .get(options.feedId) as { count: number };

    const articles = db
      .prepare(
        `
        ${buildFeedArticleSelect()}
        WHERE a.feed_id = ?
          AND ${buildAutoHiddenWhereClause('a')}
        ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.fetched_at DESC
        LIMIT ?
      `,
      )
      .all(options.feedId, HIDDEN_FEED_CONTENT_LIMIT) as FeedArticleRow[];

    return {
      articles,
      page: 1,
      totalPages: 1,
      totalArticles: countResult.count,
      hiddenContentLimit: HIDDEN_FEED_CONTENT_LIMIT,
    };
  }

  const limit = Math.min(
    200,
    Math.max(1, Math.floor(options.limit || DEFAULT_FEED_PAGE_LIMIT)),
  );
  const offset = options.offset ?? (page - 1) * limit;
  const sort = parseArticleSort(options.sort);

  const filterWhere = ['a.hidden = 0', 'a.feed_id = ?'];
  const filterParams: Array<string | number> = [options.feedId];
  if (options.unreadOnly) {
    filterWhere.push('a.read = 0');
  }
  if (
    typeof options.snapshotAt === 'number' &&
    Number.isSafeInteger(options.snapshotAt)
  ) {
    filterWhere.push('a.fetched_at <= ?');
    filterParams.push(options.snapshotAt);
  }

  const countResult = db
    .prepare(
      `SELECT COUNT(*) as count FROM articles a WHERE ${filterWhere.join(' AND ')}`,
    )
    .get(...filterParams) as { count: number };

  const queryWhere = [...filterWhere];
  const queryParams = [...filterParams];
  const excludeIds = (options.excludeIds || []).filter(Boolean).slice(0, 200);
  if (excludeIds.length > 0) {
    queryWhere.push(`a.id NOT IN (${excludeIds.map(() => '?').join(', ')})`);
    queryParams.push(...excludeIds);
  }

  const orderBy =
    sort === 'newest'
      ? 'COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC'
      : sort === 'oldest'
        ? 'COALESCE(a.published_at, a.fetched_at) ASC, a.id ASC'
        : `${rankingOrderExpression('a')} DESC, COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC`;

  const articles = db
    .prepare(
      `
      ${buildFeedArticleSelect()}
      WHERE ${queryWhere.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `,
    )
    .all(...queryParams, limit, offset) as FeedArticleRow[];

  return {
    articles,
    page,
    totalPages: Math.ceil(countResult.count / limit),
    totalArticles: countResult.count,
    hiddenContentLimit: null,
  };
}
