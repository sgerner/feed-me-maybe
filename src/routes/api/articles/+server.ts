import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.sessionId) {
    throw error(401, 'Unauthorized');
  }

  const db = getDb();
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const feedId = url.searchParams.get('feedId');
  const limit = 25;
  const offset = (page - 1) * limit;

  let query = `
    SELECT a.id, a.feed_id, a.url, a.title, a.author, a.summary, a.image_url, a.categories,
           a.published_at, a.fetched_at, a.read, a.saved, a.hidden, a.heuristic_score, a.combined_score,
           f.title as feed_title, f.url as feed_url, f.open_mode as feed_open_mode
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id
    WHERE a.hidden = 0
  `;
  const params: any[] = [];

  if (feedId) {
    query += ' AND a.feed_id = ?';
    params.push(feedId);
  }

  query += `
    ORDER BY COALESCE(a.combined_score, a.heuristic_score, 0) DESC, a.published_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  const articles = db.prepare(query).all(...params);

  return json({ articles });
};
