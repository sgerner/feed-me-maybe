import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getFeedArticles } from '$lib/server/feed/articles';
import { queryGlobalArticleRanking } from '$lib/server/ranking';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.sessionId) {
    throw error(401, 'Unauthorized');
  }

  const db = getDb();
  const page = Math.max(
    1,
    parseInt(url.searchParams.get('page') || '1', 10) || 1,
  );
  const feedId = url.searchParams.get('feedId');
  const unreadOnly = url.searchParams.get('unread') === '1';
  const limit = 25;
  const rawOffset = url.searchParams.get('offset');
  const offset =
    rawOffset !== null && /^\d{1,8}$/.test(rawOffset)
      ? Number(rawOffset)
      : (page - 1) * limit;

  let whereClause = 'a.hidden = 0 AND a.thumbs_down = 0';
  const params: string[] = [];

  if (feedId && !unreadOnly) {
    return json({
      articles: getFeedArticles({ feedId, page, offset }).articles,
    });
  }
  const category = url.searchParams.get('category');
  if (category) {
    whereClause += ' AND TRIM(f.category) = ? AND f.enabled = 1';
    params.push(category);
  }

  if (unreadOnly) {
    whereClause += ' AND a.read = 0';
  }

  const articles = queryGlobalArticleRanking(
    db,
    whereClause,
    params,
    limit,
    offset,
  );

  return json({ articles });
};
