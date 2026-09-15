import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) throw error(401, 'Unauthorized');

  const db = getDb();
  const totalResult = db
    .prepare(
      'SELECT COUNT(*) AS count FROM articles WHERE hidden = 0 AND read = 0 AND thumbs_down = 0',
    )
    .get() as { count: number };
  const limit = 25;
  const articles = db
    .prepare(
      `
      SELECT a.id, a.feed_id, a.url, a.title, a.author, a.summary, a.image_url,
             a.categories, a.published_at, a.fetched_at, a.read, a.saved,
             a.hidden, a.thumbs_up, a.thumbs_down, a.heuristic_score,
             a.combined_score, f.title AS feed_title, f.url AS feed_url,
             f.open_mode AS feed_open_mode
      FROM articles a
      JOIN feeds f ON f.id = a.feed_id
      WHERE a.hidden = 0 AND a.read = 0 AND a.thumbs_down = 0
      ORDER BY COALESCE(a.combined_score, a.heuristic_score, 0) DESC,
               COALESCE(a.published_at, a.fetched_at) DESC, a.id DESC
      LIMIT ?
    `,
    )
    .all(limit);

  return {
    articles,
    totalPages: Math.max(1, Math.ceil(totalResult.count / limit)),
    totalArticles: totalResult.count,
  };
};
