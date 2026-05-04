import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createWebhook, updateWebhook, deleteWebhook } from '$lib/server/webhooks';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) return json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { name, url, events, secret } = body;

  if (!name || !url || !events) {
    return json({ error: 'name, url, and events are required' }, { status: 400 });
  }

  try {
    const id = createWebhook(name, url, events, secret);
    return json({ success: true, id });
  } catch (err: any) {
    return json({ error: err.message }, { status: 500 });
  }
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) return json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { id, ...updates } = body;

  if (!id) return json({ error: 'id is required' }, { status: 400 });

  try {
    updateWebhook(id, updates);
    return json({ success: true });
  } catch (err: any) {
    return json({ error: err.message }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) return json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await request.json();

  if (!id) return json({ error: 'id is required' }, { status: 400 });

  try {
    deleteWebhook(id);
    return json({ success: true });
  } catch (err: any) {
    return json({ error: err.message }, { status: 500 });
  }
};
