import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  createWebhook,
  updateWebhook,
  deleteWebhook,
  isWebhookEventList,
} from '$lib/server/webhooks';
import { SafeFetchError } from '$lib/server/network';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { name, url, events, secret } = body;

  const missingField = !name
    ? 'name'
    : !url
      ? 'url'
      : !isWebhookEventList(events)
        ? 'events'
        : null;

  if (missingField) {
    return json(
      {
        error: 'Name, target URL, and at least one event are required.',
        field: missingField,
      },
      { status: 400 },
    );
  }

  try {
    const id = createWebhook(name, url, events, secret);
    return json({ success: true, id });
  } catch (err: any) {
    if (err instanceof SafeFetchError) {
      return json({ error: err.message, field: 'url' }, { status: 400 });
    }
    return json({ error: err.message }, { status: 500 });
  }
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { id, ...updates } = body;

  if (!id) return json({ error: 'id is required' }, { status: 400 });
  if (updates.events !== undefined && !isWebhookEventList(updates.events)) {
    return json(
      { error: 'Select at least one supported event', field: 'events' },
      { status: 400 },
    );
  }
  if (updates.secret !== undefined && typeof updates.secret !== 'string') {
    return json(
      { error: 'Signing secret must be text', field: 'secret' },
      { status: 400 },
    );
  }

  try {
    updateWebhook(id, updates);
    return json({ success: true });
  } catch (err: any) {
    if (err instanceof SafeFetchError) {
      return json({ error: err.message }, { status: 400 });
    }
    return json({ error: err.message }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await request.json();

  if (!id) return json({ error: 'id is required' }, { status: 400 });

  try {
    deleteWebhook(id);
    return json({ success: true });
  } catch (err: any) {
    return json({ error: err.message }, { status: 500 });
  }
};
