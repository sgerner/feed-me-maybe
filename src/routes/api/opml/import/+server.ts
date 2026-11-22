import type { RequestHandler } from './$types';
import { readJsonObject } from '#lib/server/request-body.ts';
import { importOpml } from '#lib/server/opml.ts';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await readJsonObject(request);
  if (!body) {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { opml } = body;
  if (typeof opml !== 'string' || !opml)
    return Response.json({ error: 'OPML content required' }, { status: 400 });

  const result = importOpml(opml);
  return Response.json(result);
};
