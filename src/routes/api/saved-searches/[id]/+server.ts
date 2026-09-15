import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  deleteSavedSearch,
  SavedSearchError,
  updateSavedSearch,
} from '$lib/server/saved-searches';

function errorResponse(caught: unknown, fallback: string): Response {
  if (caught instanceof SavedSearchError) {
    return json({ error: caught.message }, { status: caught.status });
  }
  return json({ error: fallback }, { status: 500 });
}

export const PATCH: RequestHandler = async ({ request, locals, params }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }
  try {
    const savedSearch = updateSavedSearch(params.id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      query: typeof body.query === 'string' ? body.query : undefined,
      description:
        typeof body.description === 'string' ? body.description : undefined,
      pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
    });
    return json({ savedSearch });
  } catch (caught) {
    return errorResponse(caught, 'Failed to update saved search');
  }
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });
  try {
    if (!deleteSavedSearch(params.id)) {
      return json({ error: 'Saved search not found' }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (caught) {
    return errorResponse(caught, 'Failed to delete saved search');
  }
};
