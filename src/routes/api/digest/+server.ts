import type { RequestHandler } from './$types';
import {
  getWeeklyDigestArticles,
  parseDigestQuery,
} from '#lib/server/digest.ts';

export const GET: RequestHandler = async ({ locals, url, request }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const query = parseDigestQuery(url);
    const digest = await getWeeklyDigestArticles({
      ...query,
      signal: request.signal,
    });
    return Response.json(digest);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('days must be')) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    console.error('[api] Failed to build weekly digest:', err);
    return Response.json(
      { error: 'Failed to build weekly digest' },
      { status: 500 },
    );
  }
};
