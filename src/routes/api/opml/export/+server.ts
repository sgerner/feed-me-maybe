import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { exportOpml } from '$lib/server/opml';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });

  const opml = exportOpml();

  return new Response(opml, {
    headers: {
      'Content-Type': 'text/xml',
      'Content-Disposition': 'attachment; filename="feed-me-maybe-export.opml"',
    },
  });
};
