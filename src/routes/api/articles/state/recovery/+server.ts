import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchArticles, SearchQueryError } from '$lib/server/search';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const kind = (url.searchParams.get('kind') || 'hidden').toLowerCase();
  if (!['hidden', 'rejected', 'all'].includes(kind)) {
    return json(
      { error: 'kind must be hidden, rejected, or all' },
      { status: 400 },
    );
  }
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return json(
      { error: 'limit must be an integer between 1 and 100' },
      { status: 400 },
    );
  }

  try {
    const query = kind === 'all' ? '' : `is:${kind}`;
    return json({ kind, ...searchArticles({ query, limit }) });
  } catch (caught) {
    const message =
      caught instanceof SearchQueryError
        ? caught.message
        : 'Failed to load recovery articles';
    return json({ error: message }, { status: 400 });
  }
};
