import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getArticleStateHistory } from '$lib/server/article-state';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > 100)
  ) {
    return json(
      { error: 'limit must be an integer between 1 and 100' },
      { status: 400 },
    );
  }

  return json({
    history: getArticleStateHistory({
      articleId: url.searchParams.get('articleId') || undefined,
      limit,
    }),
  });
};
