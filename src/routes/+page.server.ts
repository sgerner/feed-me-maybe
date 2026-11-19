import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { queryGlobalArticleRanking } from '$lib/server/ranking';

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.sessionId) {
    throw error(401, 'Unauthorized');
  }

  const db = getDb();
  const category = url.searchParams.get('category')?.trim() || '';
  const conditions = category
    ? ' AND TRIM(f.category) = ? AND f.enabled = 1'
    : '';
  const parameters = category ? [category] : [];

  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const limit = 25;
  const offset = (page - 1) * limit;

  const countResult = db
    .prepare(
      `SELECT COUNT(*) as count FROM articles a JOIN feeds f ON f.id = a.feed_id WHERE a.hidden = 0 AND a.thumbs_down = 0${conditions}`,
    )
    .get(...parameters) as { count: number };
  const totalArticles = countResult.count;
  const totalPages = Math.ceil(totalArticles / limit);

  const articles = queryGlobalArticleRanking(
    db,
    'a.hidden = 0 AND a.thumbs_down = 0' + conditions,
    parameters,
    limit,
    offset,
  );

  return {
    category,
    articles,
    page,
    totalPages,
    totalArticles,
  };
};
