import type { RequestHandler } from './$types';
import {
  createWebhook,
  updateWebhook,
  deleteWebhook,
  isWebhookEventList,
  WebhookNotFoundError,
} from '#lib/server/webhooks.ts';
import { SafeFetchError } from '#lib/server/network.ts';
import { readJsonObject } from '#lib/server/request-body.ts';

const invalidBody = () =>
  Response.json({ error: 'Invalid body' }, { status: 400 });

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await readJsonObject(request);
  if (!body) return invalidBody();
  const { name, url, events, secret } = body;

  const missingField =
    typeof name !== 'string' || !name.trim()
      ? 'name'
      : typeof url !== 'string' || !url.trim()
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
    const id = await createWebhook(
      (name as string).trim(),
      (url as string).trim(),
      events as string[],
      typeof secret === 'string' ? secret : undefined,
    );
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

  const body = await readJsonObject(request);
  if (!body) return invalidBody();
  const { id, ...updates } = body;

  if (typeof id !== 'string' || !id)
    return Response.json({ error: 'id is required' }, { status: 400 });
  if (
    updates.name !== undefined &&
    (typeof updates.name !== 'string' || !updates.name.trim())
  ) {
    return Response.json(
      { error: 'Name must be non-empty text', field: 'name' },
      { status: 400 },
    );
  }
  if (
    updates.url !== undefined &&
    (typeof updates.url !== 'string' || !updates.url.trim())
  ) {
    return Response.json(
      { error: 'Target URL must be non-empty text', field: 'url' },
      { status: 400 },
    );
  }
  if (updates.events !== undefined && !isWebhookEventList(updates.events)) {
    return Response.json(
      { error: 'Select at least one supported event', field: 'events' },
      { status: 400 },
    );
  }
  if (
    updates.secret !== undefined &&
    updates.secret !== null &&
    typeof updates.secret !== 'string'
  ) {
    return Response.json(
      { error: 'Signing secret must be text', field: 'secret' },
      { status: 400 },
    );
  }
  if (updates.enabled !== undefined && typeof updates.enabled !== 'boolean') {
    return Response.json(
      { error: 'enabled must be a boolean', field: 'enabled' },
      { status: 400 },
    );
  }

  try {
    await updateWebhook(id, {
      ...(typeof updates.name === 'string'
        ? { name: updates.name.trim() }
        : {}),
      ...(typeof updates.url === 'string' ? { url: updates.url.trim() } : {}),
      ...(Array.isArray(updates.events)
        ? { events: updates.events as string[] }
        : {}),
      ...(updates.secret === null || typeof updates.secret === 'string'
        ? { secret: updates.secret }
        : {}),
      ...(typeof updates.enabled === 'boolean'
        ? { enabled: updates.enabled }
        : {}),
    });
    return Response.json({ success: true });
  } catch (err: any) {
    if (err instanceof WebhookNotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof SafeFetchError) {
      return Response.json(
        { error: err.message, field: 'url' },
        { status: 400 },
      );
    }
    return Response.json({ error: err.message }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await readJsonObject(request);
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
