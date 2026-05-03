import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) throw error(401, 'Unauthorized');
  const db = getDb();
  const articles = db.prepare(`
    SELECT a.id, a.title, a.url, a.hidden, a.heuristic_score,
           f.title as feed_title,
           (SELECT interaction_type FROM user_interactions WHERE article_id = a.id ORDER BY timestamp DESC LIMIT 1) as last_action
    FROM articles a JOIN feeds f ON f.id = a.feed_id
    WHERE a.hidden = 1
    ORDER BY a.fetched_at DESC LIMIT 100
  `).all();
  return { articles };
};