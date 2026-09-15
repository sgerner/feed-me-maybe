import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { buildGlobalArticleRankingQuery } from '$lib/server/ranking';

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
      `${buildGlobalArticleRankingQuery('a.hidden = 0 AND a.read = 0 AND a.thumbs_down = 0')} LIMIT ?`,
    )
    .all(limit);

  return {
    articles,
    totalPages: Math.max(1, Math.ceil(totalResult.count / limit)),
    totalArticles: totalResult.count,
  };
};
