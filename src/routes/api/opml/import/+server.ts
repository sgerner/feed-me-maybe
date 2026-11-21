import type { RequestHandler } from './$types';
import { importOpml } from '#lib/server/opml.ts';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { opml?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }

  if (!body.opml)
    return Response.json({ error: 'OPML content required' }, { status: 400 });

  const result = importOpml(body.opml);
  return Response.json(result);
};
