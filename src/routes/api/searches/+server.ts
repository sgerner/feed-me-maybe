import type { RequestHandler } from './$types';
import { readJsonObject } from '#lib/server/request-body.ts';
import type { SearchSort } from '#lib/server/search.ts';
import {
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  SavedSearchError,
  type SavedSearchInput,
  updateSavedSearch,
} from '#lib/server/saved-searches.ts';

function parseSortField(value: unknown): SearchSort | undefined {
  if (value === undefined) return undefined;
  if (value === 'recent' || value === 'relevance') return value;
  throw new SavedSearchError('sort must be recent or relevance');
}

function parseOptionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw new SavedSearchError(`${field} must be a string`);
}

function parseOptionalBoolean(
  value: unknown,
  field: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new SavedSearchError(`${field} must be a boolean`);
}

function inputFromBody(body: Record<string, unknown>): SavedSearchInput {
  return {
    name: parseOptionalString(body.name, 'name') ?? '',
    query: parseOptionalString(body.query, 'query') ?? '',
    description: parseOptionalString(body.description, 'description'),
    sort: parseSortField(body.sort),
    pinned: parseOptionalBoolean(body.pinned, 'pinned'),
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
      { status: error instanceof SavedSearchError ? error.status : 400 },
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
      name: parseOptionalString(body.name, 'name'),
      query: parseOptionalString(body.query, 'query'),
      description: parseOptionalString(body.description, 'description'),
      sort: parseSortField(body.sort),
      pinned: parseOptionalBoolean(body.pinned, 'pinned'),
    });
    return Response.json({ search });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Invalid saved search';
    return Response.json(
      { error: message },
      { status: error instanceof SavedSearchError ? error.status : 400 },
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
