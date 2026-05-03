import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';

export const load: PageServerLoad = async ({ params, locals }) => {
  if (!locals.sessionId) {
    throw error(401, 'Unauthorized');
  }

  const db = getDb();
  const article = db.prepare(`
    SELECT a.*, f.title as feed_title, f.url as feed_url, f.site_url as feed_site_url,
           am.summary as ai_summary, am.topics, am.content_type, am.explanation
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id
    LEFT JOIN article_ai_metadata am ON am.article_id = a.id
    WHERE a.id = ?
  `).get(params.id) as Record<string, unknown> | undefined;

  if (!article) {
    throw error(404, 'Article not found');
  }

  // Mark as read
  db.prepare('UPDATE articles SET read = 1 WHERE id = ?').run(params.id);

  return { article };
};