import { getDb } from '$lib/server/db';

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
  showHiddenContent?: boolean;
};

function buildAutoHiddenWhereClause(alias: string): string {
  return `
    ${alias}.hidden = 1
    AND EXISTS (
      SELECT 1
      FROM user_interactions ui
      WHERE ui.article_id = ${alias}.id
        AND ui.interaction_type = 'hide'
        AND json_extract(ui.metadata, '$.auto') = 1
        AND json_extract(ui.metadata, '$.reason') = 'preference_model'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM user_interactions ui
      WHERE ui.article_id = ${alias}.id
        AND ui.interaction_type = 'hide'
        AND (
          json_extract(ui.metadata, '$.auto') IS NULL
          OR json_extract(ui.metadata, '$.reason') IS NULL
          OR json_extract(ui.metadata, '$.reason') != 'preference_model'
        )
    )
  `;
}

function buildFeedArticleSelect(): string {
  return `
    SELECT a.id, a.feed_id, a.url, a.title, a.author, a.summary, a.image_url, a.categories,
           a.published_at, a.fetched_at, a.read, a.saved, a.hidden, a.heuristic_score, a.combined_score,
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

  const limit = DEFAULT_FEED_PAGE_LIMIT;
  const offset = (page - 1) * limit;

  const countResult = db
    .prepare(
      'SELECT COUNT(*) as count FROM articles WHERE hidden = 0 AND feed_id = ?',
    )
    .get(options.feedId) as { count: number };

  const articles = db
    .prepare(
      `
      ${buildFeedArticleSelect()}
      WHERE a.hidden = 0 AND a.feed_id = ?
      ORDER BY COALESCE(a.combined_score, a.heuristic_score, 0) DESC, a.published_at DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(options.feedId, limit, offset) as FeedArticleRow[];

  return {
    articles,
    page,
    totalPages: Math.ceil(countResult.count / limit),
    totalArticles: countResult.count,
    hiddenContentLimit: null,
  };
}
