import type { RequestHandler } from './$types';
import {
  clearFeedArticles,
  getFeedExists,
} from '#lib/server/feed-management.ts';

export const POST: RequestHandler = async ({ params, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const feed = getFeedExists(params.id);
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
