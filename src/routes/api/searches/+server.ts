import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  SavedSearchError,
  updateSavedSearch,
} from '$lib/server/saved-searches';

type SavedSearchInput = {
  name: string;
  query?: string;
  description?: string;
  pinned?: boolean;
};

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Request body must be an object');
    }
    return body as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new Error('Invalid request body', { cause: error });
    }
    throw error;
  }
}

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
    return json({ error: 'Unauthorized' }, { status: 401 });
  return json({ searches: listSavedSearches() });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const search = createSavedSearch(inputFromBody(await readBody(request)));
    return json({ search }, { status: 201 });
  } catch (error: unknown) {
    return json(
      {
        error: error instanceof Error ? error.message : 'Invalid saved search',
      },
      { status: 400 },
    );
  }
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await readBody(request);
    if (typeof body.id !== 'string' || !body.id.trim()) {
      return json({ error: 'id is required' }, { status: 400 });
    }
    const search = updateSavedSearch(body.id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      query: typeof body.query === 'string' ? body.query : undefined,
      description:
        typeof body.description === 'string' ? body.description : undefined,
      pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
    });
    return json({ search });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Invalid saved search';
    return json(
      { error: message },
      { status: message.includes('not found') ? 404 : 400 },
    );
  }
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await readBody(request);
    if (typeof body.id !== 'string' || !body.id.trim()) {
      return json({ error: 'id is required' }, { status: 400 });
    }
    return deleteSavedSearch(body.id)
      ? json({ success: true })
      : json({ error: 'Saved search not found' }, { status: 404 });
  } catch (error: unknown) {
    return json(
      {
        error: error instanceof Error ? error.message : 'Invalid request body',
      },
      { status: error instanceof SavedSearchError ? error.status : 400 },
    );
  }
};
