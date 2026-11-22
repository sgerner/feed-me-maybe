import type { RequestHandler } from './$types';
import { readJsonObject } from '#lib/server/request-body.ts';
import {
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  SavedSearchError,
  updateSavedSearch,
} from '#lib/server/saved-searches.ts';

type SavedSearchInput = {
  name: string;
  query?: string;
  description?: string;
  pinned?: boolean;
};

function inputFromBody(body: Record<string, unknown>): SavedSearchInput {
  return {
    name: typeof body.name === 'string' ? body.name : '',
    query: typeof body.query === 'string' ? body.query : '',
    description:
      typeof body.description === 'string' ? body.description : undefined,
    pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
  };
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  return Response.json({ searches: listSavedSearches() });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await readJsonObject(request);
  if (!body) {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  try {
    const search = createSavedSearch(inputFromBody(body));
    return Response.json({ search }, { status: 201 });
  } catch (error: unknown) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Invalid saved search',
      },
      { status: 400 },
    );
  }
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await readJsonObject(request);
  if (!body) {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  try {
    if (typeof body.id !== 'string' || !body.id.trim()) {
      return Response.json({ error: 'id is required' }, { status: 400 });
    }
    const search = updateSavedSearch(body.id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      query: typeof body.query === 'string' ? body.query : undefined,
      description:
        typeof body.description === 'string' ? body.description : undefined,
      pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
    });
    return Response.json({ search });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Invalid saved search';
    return Response.json(
      { error: message },
      { status: message.includes('not found') ? 404 : 400 },
    );
  }
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await readJsonObject(request);
  if (!body) {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  try {
    if (typeof body.id !== 'string' || !body.id.trim()) {
      return Response.json({ error: 'id is required' }, { status: 400 });
    }
    return deleteSavedSearch(body.id)
      ? Response.json({ success: true })
      : Response.json({ error: 'Saved search not found' }, { status: 404 });
  } catch (error: unknown) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Invalid request body',
      },
      { status: error instanceof SavedSearchError ? error.status : 400 },
    );
  }
};
