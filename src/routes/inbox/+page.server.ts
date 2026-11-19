import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { queryGlobalArticleRanking } from '$lib/server/ranking';

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.sessionId) throw error(401, 'Unauthorized');

  const db = getDb();
  const category = url.searchParams.get('category')?.trim() || '';
  const conditions = category
    ? ' AND TRIM(f.category) = ? AND f.enabled = 1'
    : '';
  const parameters = category ? [category] : [];

  const totalResult = db
    .prepare(
      `SELECT COUNT(*) AS count FROM articles a JOIN feeds f ON f.id = a.feed_id WHERE a.hidden = 0 AND a.read = 0 AND a.thumbs_down = 0${conditions}`,
    )
    .get(...parameters) as { count: number };
  const limit = 25;
  const articles = queryGlobalArticleRanking(
    db,
    'a.hidden = 0 AND a.read = 0 AND a.thumbs_down = 0' + conditions,
    parameters,
    limit,
  );

  return {
    category,
    articles,
    totalPages: Math.max(1, Math.ceil(totalResult.count / limit)),
    totalArticles: totalResult.count,
  };
};
