import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  createSavedSearch,
  listSavedSearches,
  SavedSearchError,
} from '$lib/server/saved-searches';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });
  return json({ savedSearches: listSavedSearches() });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }
  if (typeof body.name !== 'string') {
    return json({ error: 'name is required' }, { status: 400 });
  }
  try {
    const savedSearch = createSavedSearch({
      name: body.name,
      query: typeof body.query === 'string' ? body.query : '',
      description:
        typeof body.description === 'string' ? body.description : undefined,
      pinned: typeof body.pinned === 'boolean' ? body.pinned : false,
    });
    return json({ savedSearch }, { status: 201 });
  } catch (caught) {
    if (caught instanceof SavedSearchError) {
      return json({ error: caught.message }, { status: caught.status });
    }
    return json({ error: 'Failed to create saved search' }, { status: 500 });
  }
};
