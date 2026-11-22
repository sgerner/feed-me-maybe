import type { RequestHandler } from './$types';
import {
  ArticleStateError,
  listRecoverySearchArticles,
} from '#lib/server/article-state.ts';
import { searchArticles, SearchQueryError } from '#lib/server/search.ts';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const kind = (url.searchParams.get('kind') || 'hidden').toLowerCase();
  if (!['hidden', 'rejected', 'all'].includes(kind)) {
    return Response.json(
      { error: 'kind must be hidden, rejected, or all' },
      { status: 400 },
    );
  }
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return Response.json(
      { error: 'limit must be an integer between 1 and 100' },
      { status: 400 },
    );
  }
  const cursor = url.searchParams.get('cursor') || undefined;

  try {
    if (kind === 'all') {
      return Response.json({
        kind,
        ...listRecoverySearchArticles({ limit, cursor, kind: 'all' }),
      });
    }
    return Response.json({
      kind,
      ...searchArticles({ query: `is:${kind}`, limit, cursor }),
    });
  } catch (caught) {
    const message =
      caught instanceof SearchQueryError || caught instanceof ArticleStateError
        ? caught.message
        : 'Failed to load recovery articles';
    return Response.json({ error: message }, { status: 400 });
  }
};
