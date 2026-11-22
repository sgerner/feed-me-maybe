import type { RequestHandler } from './$types';
import {
  deleteWebhook,
  isWebhookEventList,
  updateWebhook,
  WebhookNotFoundError,
} from '#lib/server/webhooks.ts';
import { SafeFetchError } from '#lib/server/network.ts';
import { readJsonObject } from '#lib/server/request-body.ts';

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const id = params.id?.trim();
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }

  const updates = await readJsonObject(request);
  if (!updates) {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }

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
    return Response.json(
      {
        error: err instanceof Error ? err.message : 'Failed to update webhook',
      },
      { status: 500 },
    );
  }
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const id = params.id?.trim();
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }

  try {
    deleteWebhook(id);
    return Response.json({ success: true });
  } catch (err: any) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : 'Failed to delete webhook',
      },
      { status: 500 },
    );
  }
};
