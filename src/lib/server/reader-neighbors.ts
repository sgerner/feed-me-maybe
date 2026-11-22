import type Database from 'better-sqlite3';
import { validateStreamOrigin } from '#lib/reader-queue.ts';
import { getCachedDigestNeighbors } from '#lib/server/digest.ts';
import {
  buildAutoHiddenWhereClause,
  HIDDEN_FEED_CONTENT_LIMIT,
} from '#lib/server/feed/articles.ts';
import {
  parseArticleSort,
  rankingOrderExpression,
  rankingScoreExpression,
  type ArticleSort,
} from '#lib/server/ranking.ts';
import { findSearchNeighbors } from '#lib/server/search.ts';

export type ArticleNeighbors = {
  previous: string | null;
  next: string | null;
};

type ArticleNeighborSeed = {
  id: string;
  feed_id: string;
  published_at?: number | null;
  fetched_at?: number | null;
};

const INTERNAL_ORIGIN = 'http://feed-me-maybe.local';

function singleFeedNeighbors(
  db: Database.Database,
  article: ArticleNeighborSeed,
): ArticleNeighbors {
  const published = Number(article.published_at ?? article.fetched_at);
  const queryNeighbor = (previous: boolean): string | null => {
    const comparison = previous ? '>' : '<';
    const order = previous ? 'ASC' : 'DESC';
    const row = db
      .prepare(
        `
        SELECT id FROM articles
        WHERE feed_id = ? AND hidden = 0 AND thumbs_down = 0
          AND (COALESCE(published_at, fetched_at), id) ${comparison} (?, ?)
        ORDER BY COALESCE(published_at, fetched_at) ${order}, id ${order}
        LIMIT 1
      `,
      )
      .get(article.feed_id, published, article.id) as
      { id: string } | undefined;
    return row?.id ?? null;
  };

  return {
    previous: queryNeighbor(true),
    next: queryNeighbor(false),
  };
}

function queryGlobalStreamNeighbors(
  db: Database.Database,
  articleId: string,
  options: {
    category: string;
    sort: ArticleSort;
    unreadOnly: boolean;
  },
): ArticleNeighbors {
  const whereParts = ['f.enabled = 1', 'a.hidden = 0', 'a.thumbs_down = 0'];
  const whereParams: Array<string | number> = [];

  if (options.unreadOnly) {
    whereParts.push('(a.read = 0 OR a.id = ?)');
    whereParams.push(articleId);
  }
  if (options.category) {
    whereParts.push('TRIM(f.category) = ?');
    whereParams.push(options.category);
  }

  const whereClause = whereParts.join(' AND ');

  if (options.sort === 'newest' || options.sort === 'oldest') {
    const dir = options.sort === 'oldest' ? 'ASC' : 'DESC';
    const row = db
      .prepare(
        `
        WITH ordered AS (
          SELECT a.id,
                 LAG(a.id) OVER (
                   ORDER BY COALESCE(a.published_at, a.fetched_at) ${dir}, a.id ${dir}
                 ) AS previous_id,
                 LEAD(a.id) OVER (
                   ORDER BY COALESCE(a.published_at, a.fetched_at) ${dir}, a.id ${dir}
                 ) AS next_id
          FROM articles a
          JOIN feeds f ON f.id = a.feed_id
          WHERE ${whereClause}
        )
        SELECT previous_id, next_id FROM ordered WHERE id = ?
      `,
      )
      .get(...whereParams, articleId) as
      { previous_id: string | null; next_id: string | null } | undefined;
    return {
      previous: row?.previous_id ?? null,
      next: row?.next_id ?? null,
    };
  }

  const score = rankingScoreExpression('a');
  const partitionReadExpr = options.unreadOnly
    ? 'CASE WHEN a.id = ? THEN 0 ELSE a.read END'
    : 'a.read';
  const partitionParams = options.unreadOnly ? [articleId] : [];
  const row = db
    .prepare(
      `
      WITH ranked_article_ids AS (
        SELECT a.id, a.feed_id, a.published_at, a.fetched_at,
               ${score} AS rank_score,
               ROW_NUMBER() OVER (
                 PARTITION BY a.feed_id, ${partitionReadExpr}
                 ORDER BY ${score} DESC,
                          COALESCE(a.published_at, a.fetched_at) DESC,
                          a.id DESC
               ) AS feed_rank
        FROM articles a
        JOIN feeds f ON f.id = a.feed_id
        WHERE ${whereClause}
      ),
      ordered AS (
        SELECT id,
               LAG(id) OVER (
                 ORDER BY rank_score - MIN((feed_rank - 1) * 2.5, 15) DESC,
                          COALESCE(published_at, fetched_at) DESC,
                          id DESC
               ) AS previous_id,
               LEAD(id) OVER (
                 ORDER BY rank_score - MIN((feed_rank - 1) * 2.5, 15) DESC,
                          COALESCE(published_at, fetched_at) DESC,
                          id DESC
               ) AS next_id
        FROM ranked_article_ids
      )
      SELECT previous_id, next_id FROM ordered WHERE id = ?
    `,
    )
    .get(...partitionParams, ...whereParams, articleId) as
    { previous_id: string | null; next_id: string | null } | undefined;

  return {
    previous: row?.previous_id ?? null,
    next: row?.next_id ?? null,
  };
}

function queryFeedStreamNeighbors(
  db: Database.Database,
  articleId: string,
  feedId: string,
  options: {
    showHiddenContent: boolean;
    unreadOnly: boolean;
    sort: ArticleSort;
  },
): ArticleNeighbors {
  if (options.showHiddenContent) {
    const row = db
      .prepare(
        `
        WITH limited AS (
          SELECT a.id
          FROM articles a
          JOIN feeds f ON f.id = a.feed_id
          WHERE a.feed_id = ?
            AND ${buildAutoHiddenWhereClause('a')}
          ORDER BY COALESCE(a.published_at, a.fetched_at) DESC, a.fetched_at DESC
          LIMIT ?
        ),
        ordered AS (
          SELECT id,
                 LAG(id) OVER () AS previous_id,
                 LEAD(id) OVER () AS next_id
          FROM limited
        )
        SELECT previous_id, next_id FROM ordered WHERE id = ?
      `,
      )
      .get(feedId, HIDDEN_FEED_CONTENT_LIMIT, articleId) as
      { previous_id: string | null; next_id: string | null } | undefined;

    return {
      previous: row?.previous_id ?? null,
      next: row?.next_id ?? null,
    };
  }

  const whereParts = ['a.hidden = 0', 'a.feed_id = ?'];
  const whereParams: Array<string | number> = [feedId];
  if (options.unreadOnly) {
    whereParts.push('(a.read = 0 OR a.id = ?)');
    whereParams.push(articleId);
  }

  const orderBy =
    options.sort === 'newest'
      ? 'COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC'
      : options.sort === 'oldest'
        ? 'COALESCE(a.published_at, a.fetched_at) ASC, a.id ASC'
        : `${rankingOrderExpression('a')} DESC, COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC`;

  const row = db
    .prepare(
      `
      WITH ordered AS (
        SELECT a.id,
               LAG(a.id) OVER (ORDER BY ${orderBy}) AS previous_id,
               LEAD(a.id) OVER (ORDER BY ${orderBy}) AS next_id
        FROM articles a
        JOIN feeds f ON f.id = a.feed_id
        WHERE ${whereParts.join(' AND ')}
      )
      SELECT previous_id, next_id FROM ordered WHERE id = ?
    `,
    )
    .get(...whereParams, articleId) as
    { previous_id: string | null; next_id: string | null } | undefined;

  return {
    previous: row?.previous_id ?? null,
    next: row?.next_id ?? null,
  };
}

function querySavedNeighbors(
  db: Database.Database,
  articleId: string,
): ArticleNeighbors {
  const row = db
    .prepare(
      `
      WITH ordered AS (
        SELECT a.id,
               LAG(a.id) OVER (
                 ORDER BY COALESCE(a.saved_at, a.updated_at, a.fetched_at) DESC, a.id DESC
               ) AS previous_id,
               LEAD(a.id) OVER (
                 ORDER BY COALESCE(a.saved_at, a.updated_at, a.fetched_at) DESC, a.id DESC
               ) AS next_id
        FROM articles a
        JOIN feeds f ON f.id = a.feed_id
        WHERE a.saved = 1
      )
      SELECT previous_id, next_id FROM ordered WHERE id = ?
    `,
    )
    .get(articleId) as
    { previous_id: string | null; next_id: string | null } | undefined;

  return {
    previous: row?.previous_id ?? null,
    next: row?.next_id ?? null,
  };
}

function queryRecoveryNeighbors(
  db: Database.Database,
  articleId: string,
  options: { kind: string; feedId?: string | null },
): ArticleNeighbors {
  const kindClause =
    options.kind === 'hidden'
      ? 'a.hidden = 1'
      : options.kind === 'rejected'
        ? '(a.rejected = 1 OR a.thumbs_down = 1)'
        : '(a.hidden = 1 OR a.rejected = 1 OR a.thumbs_down = 1)';
  const whereParts = ['a.cleared_at IS NULL', kindClause];
  const whereParams: Array<string | number> = [];
  if (options.feedId) {
    whereParts.push('a.feed_id = ?');
    whereParams.push(options.feedId);
  }

  const row = db
    .prepare(
      `
      WITH ordered AS (
        SELECT a.id,
               LAG(a.id) OVER (
                 ORDER BY COALESCE(a.hidden_at, a.rejected_at, a.fetched_at) DESC, a.id DESC
               ) AS previous_id,
               LEAD(a.id) OVER (
                 ORDER BY COALESCE(a.hidden_at, a.rejected_at, a.fetched_at) DESC, a.id DESC
               ) AS next_id
        FROM articles a
        JOIN feeds f ON f.id = a.feed_id
        WHERE ${whereParts.join(' AND ')}
      )
      SELECT previous_id, next_id FROM ordered WHERE id = ?
    `,
    )
    .get(...whereParams, articleId) as
    { previous_id: string | null; next_id: string | null } | undefined;

  return {
    previous: row?.previous_id ?? null,
    next: row?.next_id ?? null,
  };
}

export function resolveStreamNeighbors(
  db: Database.Database,
  article: ArticleNeighborSeed,
  rawFrom: string | null | undefined,
): { returnPath: string; neighbors: ArticleNeighbors } {
  const validFrom = validateStreamOrigin(rawFrom);
  if (!validFrom) {
    return {
      returnPath: '/',
      neighbors: singleFeedNeighbors(db, article),
    };
  }

  const fromUrl = new URL(validFrom, INTERNAL_ORIGIN);
  const pathname = fromUrl.pathname;

  if (pathname === '/' || pathname === '/today') {
    return {
      returnPath: validFrom,
      neighbors: queryGlobalStreamNeighbors(db, article.id, {
        category: fromUrl.searchParams.get('category')?.trim() || '',
        sort: parseArticleSort(fromUrl.searchParams.get('sort')),
        unreadOnly: false,
      }),
    };
  }

  if (pathname === '/inbox') {
    return {
      returnPath: validFrom,
      neighbors: queryGlobalStreamNeighbors(db, article.id, {
        category: fromUrl.searchParams.get('category')?.trim() || '',
        sort: parseArticleSort(fromUrl.searchParams.get('sort')),
        unreadOnly: true,
      }),
    };
  }

  const feedMatch = pathname.match(/^\/feeds\/([^/]+)$/);
  if (feedMatch) {
    let feedId = feedMatch[1];
    try {
      feedId = decodeURIComponent(feedId);
    } catch {
      // Keep raw segment if malformed percent-encoding was passed.
    }
    return {
      returnPath: validFrom,
      neighbors: queryFeedStreamNeighbors(db, article.id, feedId, {
        showHiddenContent: fromUrl.searchParams.get('showHidden') === '1',
        unreadOnly: fromUrl.searchParams.get('unread') === '1',
        sort: parseArticleSort(fromUrl.searchParams.get('sort')),
      }),
    };
  }

  if (pathname === '/saved') {
    return {
      returnPath: validFrom,
      neighbors: querySavedNeighbors(db, article.id),
    };
  }

  if (pathname === '/recovery') {
    const rawKind = (fromUrl.searchParams.get('kind') || 'all').toLowerCase();
    return {
      returnPath: validFrom,
      neighbors: queryRecoveryNeighbors(db, article.id, {
        kind: rawKind,
        feedId: fromUrl.searchParams.get('feedId'),
      }),
    };
  }

  if (pathname === '/search') {
    return {
      returnPath: validFrom,
      neighbors: findSearchNeighbors(article.id, {
        query:
          fromUrl.searchParams.get('q') ||
          fromUrl.searchParams.get('query') ||
          '',
        sort: fromUrl.searchParams.get('sort'),
      }),
    };
  }

  if (pathname === '/digest') {
    const rawDays =
      fromUrl.searchParams.get('days') ||
      fromUrl.searchParams.get('windowDays');
    const parsedDays =
      rawDays !== null && rawDays !== '' && /^\d+$/.test(rawDays)
        ? Number(rawDays)
        : null;
    return {
      returnPath: validFrom,
      neighbors: getCachedDigestNeighbors(article.id, parsedDays),
    };
  }

  return {
    returnPath: validFrom,
    neighbors: singleFeedNeighbors(db, article),
  };
}
