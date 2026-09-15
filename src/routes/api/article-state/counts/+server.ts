import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getArticleStateCounts } from '$lib/server/article-state';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });
  return json({
    counts: getArticleStateCounts(url.searchParams.get('feedId') || undefined),
  });
};
