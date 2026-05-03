import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { importOpml } from '$lib/server/opml';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) return json({ error: 'Unauthorized' }, { status: 401 });

  let body: { opml?: string };
  try { body = await request.json(); } catch { return json({ error: 'Invalid body' }, { status: 400 }); }

  if (!body.opml) return json({ error: 'OPML content required' }, { status: 400 });

  const result = importOpml(body.opml);
  return json(result);
};