import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';

export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.sessionId) {
    throw error(401, 'Unauthorized');
  }

  const db = getDb();
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const limit = 25;
  const offset = (page - 1) * limit;

  // Get total count
  const countResult = db.prepare("SELECT COUNT(*) as count FROM articles WHERE hidden = 0").get() as { count: number };
  const totalArticles = countResult.count;
  const totalPages = Math.ceil(totalArticles / limit);

  // Get articles ordered by combined_score DESC (heuristic_score as fallback)
  const articles = db.prepare(`
    SELECT a.id, a.feed_id, a.url, a.title, a.author, a.summary, a.image_url, a.categories,
           a.published_at, a.fetched_at, a.read, a.saved, a.hidden, a.heuristic_score, a.combined_score,
           f.title as feed_title, f.url as feed_url, f.open_mode as feed_open_mode
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id
    WHERE a.hidden = 0
    ORDER BY COALESCE(a.combined_score, a.heuristic_score, 0) DESC, a.published_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  return {
    articles,
    page,
    totalPages,
    totalArticles
  };
};