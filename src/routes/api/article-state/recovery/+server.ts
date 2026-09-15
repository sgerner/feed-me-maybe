import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listRecoveryArticles } from '$lib/server/article-state';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const limitValue = url.searchParams.get('limit');
    const limit = limitValue ? Number(limitValue) : undefined;
    if (limitValue && !Number.isInteger(limit)) {
      return json({ error: 'limit must be an integer' }, { status: 400 });
    }
    return json(
      listRecoveryArticles({
        limit,
        cursor: url.searchParams.get('cursor') || undefined,
        feedId: url.searchParams.get('feedId') || undefined,
      }),
    );
  } catch (error: unknown) {
    return json(
      {
        error: error instanceof Error ? error.message : 'Recovery query failed',
      },
      { status: 400 },
    );
  }
};
