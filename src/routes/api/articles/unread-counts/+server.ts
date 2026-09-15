import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getUnreadCounts } from '$lib/server/article-state';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }
  return json(getUnreadCounts());
};
