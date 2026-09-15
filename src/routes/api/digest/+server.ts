import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getWeeklyDigestArticles, parseDigestQuery } from '$lib/server/digest';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const query = parseDigestQuery(url);
    const digest = await getWeeklyDigestArticles(query);
    return json(digest);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('days must be')) {
      return json({ error: err.message }, { status: 400 });
    }
    console.error('[api] Failed to build weekly digest:', err);
    return json({ error: 'Failed to build weekly digest' }, { status: 500 });
  }
};
