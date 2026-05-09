import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getWeeklyDigestArticles } from '$lib/server/digest';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const digest = await getWeeklyDigestArticles();
    return json(digest);
  } catch (err) {
    console.error('[api] Failed to build weekly digest:', err);
    return json({ error: 'Failed to build weekly digest' }, { status: 500 });
  }
};
