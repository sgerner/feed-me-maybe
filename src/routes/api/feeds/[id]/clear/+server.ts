import type { RequestHandler } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import { clearFeedArticles } from '#lib/server/feed-management.ts';

export const POST: RequestHandler = async ({ params, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const feed = db
    .prepare('SELECT id FROM feeds WHERE id = ?')
    .get(params.id) as { id: string } | undefined;
  if (!feed) {
    return Response.json({ error: 'Feed not found' }, { status: 404 });
  }

  const result = clearFeedArticles(params.id);

  return Response.json({
    success: true,
    cleared: result.cleared,
    preservedSaved: result.preservedSaved,
  });
};
