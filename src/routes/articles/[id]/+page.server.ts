import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { recordInteraction } from '$lib/server/interactions';

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

  // Mark as opened
  recordInteraction(params.id, 'open');

  return { article };
};