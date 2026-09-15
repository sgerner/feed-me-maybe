import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { buildGlobalArticleRankingQuery } from '$lib/server/ranking';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.sessionId) {
    throw error(401, 'Unauthorized');
  }

  const db = getDb();
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const feedId = url.searchParams.get('feedId');
  const unreadOnly = url.searchParams.get('unread') === '1';
  const limit = 25;
  const offset = (page - 1) * limit;

  let whereClause = 'a.hidden = 0 AND a.thumbs_down = 0';
  const params: any[] = [];

  if (feedId) {
    whereClause += ' AND a.feed_id = ?';
    params.push(feedId);
  }

  if (unreadOnly) {
    whereClause += ' AND a.read = 0';
  }

  const query = `${buildGlobalArticleRankingQuery(whereClause)} LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const articles = db.prepare(query).all(...params);

  return json({ articles });
};
