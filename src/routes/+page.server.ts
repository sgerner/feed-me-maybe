import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { buildGlobalArticleRankingQuery } from '$lib/server/ranking';

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.sessionId) {
    throw error(401, 'Unauthorized');
  }

  const db = getDb();
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const limit = 25;
  const offset = (page - 1) * limit;

  const countResult = db
    .prepare('SELECT COUNT(*) as count FROM articles WHERE hidden = 0')
    .get() as { count: number };
  const totalArticles = countResult.count;
  const totalPages = Math.ceil(totalArticles / limit);

  const articles = db
    .prepare(
      `${buildGlobalArticleRankingQuery('a.hidden = 0')} LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);

  return {
    articles,
    page,
    totalPages,
    totalArticles,
  };
};
