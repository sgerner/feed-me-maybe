import type { RequestHandler } from './$types';
import { getArticleStateHistory } from '#lib/server/article-state.ts';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > 100)
  ) {
    return Response.json(
      { error: 'limit must be an integer between 1 and 100' },
      { status: 400 },
    );
  }

  return Response.json({
    history: getArticleStateHistory({
      articleId: url.searchParams.get('articleId') || undefined,
      limit,
    }),
  });
};
