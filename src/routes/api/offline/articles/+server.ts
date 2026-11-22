import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { OfflineArticle } from '#lib/offline/types.ts';
import { getDb } from '#lib/server/db/index.ts';
import { rankingOrderExpression } from '#lib/server/ranking.ts';

const SAVED_ARTICLE_LIMIT = 100;
const UNREAD_ARTICLE_LIMIT = 150;
const MAX_BODY_CHARS = 30_000;

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId) throw error(401, 'Unauthorized');

  const db = getDb();
  const columns = `a.id, a.feed_id, a.url, a.title, a.author,
                   substr(COALESCE(a.summary, ''), 1, 3000) AS summary,
                   CASE WHEN length(a.content) <= ? THEN a.content END AS content,
                   a.image_url, a.published_at, a.fetched_at, a.read, a.saved,
                   a.hidden, a.thumbs_up, a.thumbs_down, a.cleared_at,
                   a.heuristic_score, a.combined_score,
                   f.title AS feed_title, f.url AS feed_url,
                   f.site_url AS feed_site_url, f.open_mode AS feed_open_mode,
                   f.enabled AS feed_enabled`;
  const savedSort = `ORDER BY COALESCE(a.saved_at, a.updated_at, a.fetched_at) DESC, a.id DESC`;
  const savedArticles = db
    .prepare(
      `SELECT ${columns}
       FROM articles a JOIN feeds f ON f.id = a.feed_id
       WHERE a.saved = 1
       ${savedSort}
       LIMIT ?`,
    )
    .all(MAX_BODY_CHARS, SAVED_ARTICLE_LIMIT) as OfflineArticle[];

  const scoreExpr = rankingOrderExpression('a');
  const articles = db
    .prepare(
      `WITH ranked_unread AS (
         SELECT a.id,
                (${scoreExpr}) AS rank_score,
                ROW_NUMBER() OVER (
                  PARTITION BY a.feed_id
                  ORDER BY ${scoreExpr} DESC,
                           COALESCE(a.published_at, a.fetched_at) DESC,
                           a.id DESC
                ) AS feed_rank
         FROM articles a
         JOIN feeds f ON f.id = a.feed_id
         WHERE a.saved = 0 AND a.read = 0 AND f.enabled = 1
           AND COALESCE(a.hidden, 0) = 0
           AND COALESCE(a.rejected, 0) = 0
           AND COALESCE(a.thumbs_down, 0) = 0
           AND a.cleared_at IS NULL
         ORDER BY rank_score - MIN((feed_rank - 1) * 2.5, 15) DESC,
                  COALESCE(a.published_at, a.fetched_at) DESC,
                  a.id DESC
         LIMIT ?
       )
       SELECT ${columns},
              (r.rank_score - MIN((r.feed_rank - 1) * 2.5, 15)) AS offline_rank_score
       FROM ranked_unread r
       JOIN articles a ON a.id = r.id
       JOIN feeds f ON f.id = a.feed_id
       ORDER BY offline_rank_score DESC,
                COALESCE(a.published_at, a.fetched_at) DESC,
                a.id DESC`,
    )
    .all(UNREAD_ARTICLE_LIMIT, MAX_BODY_CHARS) as OfflineArticle[];

  return Response.json(
    { articles, savedArticles },
    {
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        Pragma: 'no-cache',
        Vary: 'Cookie',
      },
    },
  );
};
