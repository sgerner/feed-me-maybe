import type { RequestHandler } from './$types';
import {
  createWebhook,
  updateWebhook,
  deleteWebhook,
  isWebhookEventList,
} from '#lib/server/webhooks.ts';
import { SafeFetchError } from '#lib/server/network.ts';

/** The parsed body if it is a JSON object; null for malformed JSON, null, arrays and primitives. */
async function readBody(request: Request): Promise<Record<string, any> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, any>)
      : null;
  } catch {
    return null;
  }
}

const invalidBody = () =>
  Response.json({ error: 'Invalid body' }, { status: 400 });

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await readBody(request);
  if (!body) return invalidBody();
  const { name, url, events, secret } = body;

  const missingField =
    typeof name !== 'string' || !name
      ? 'name'
      : typeof url !== 'string' || !url
        ? 'url'
        : !isWebhookEventList(events)
          ? 'events'
          : null;

  if (missingField) {
    return Response.json(
      {
        error: 'Name, target URL, and at least one event are required.',
        field: missingField,
      },
      { status: 400 },
    );
  }
  if (secret != null && typeof secret !== 'string') {
    return Response.json(
      { error: 'Signing secret must be text', field: 'secret' },
      { status: 400 },
    );
  }

  try {
    const id = createWebhook(name, url, events, secret);
    return Response.json({ success: true, id });
  } catch (err: any) {
    if (err instanceof SafeFetchError) {
      return Response.json(
        { error: err.message, field: 'url' },
        { status: 400 },
      );
    }
    return Response.json({ error: err.message }, { status: 500 });
  }
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await readBody(request);
  if (!body) return invalidBody();
  const { id, ...updates } = body;

  if (typeof id !== 'string' || !id)
    return Response.json({ error: 'id is required' }, { status: 400 });
  if (updates.name !== undefined && typeof updates.name !== 'string') {
    return Response.json(
      { error: 'Name must be text', field: 'name' },
      { status: 400 },
    );
  }
  if (updates.events !== undefined && !isWebhookEventList(updates.events)) {
    return Response.json(
      { error: 'Select at least one supported event', field: 'events' },
      { status: 400 },
    );
  }
  if (updates.secret !== undefined && typeof updates.secret !== 'string') {
    return Response.json(
      { error: 'Signing secret must be text', field: 'secret' },
      { status: 400 },
    );
  }

  try {
    updateWebhook(id, updates);
    return Response.json({ success: true });
  } catch (err: any) {
    if (err instanceof SafeFetchError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return Response.json({ error: err.message }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await readBody(request);
  if (!body) return invalidBody();
  const { id } = body;

  if (typeof id !== 'string' || !id)
    return Response.json({ error: 'id is required' }, { status: 400 });

  try {
    deleteWebhook(id);
    return Response.json({ success: true });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
};
