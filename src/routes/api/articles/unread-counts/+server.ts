import type { RequestHandler } from './$types';
import { getUnreadCounts } from '#lib/server/article-state.ts';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return Response.json(getUnreadCounts());
};
