import type { RequestHandler } from './$types';
import {
  dispatchAllFeedsRefresh,
  parseRefreshForceFlag,
} from '#lib/server/feed-management.ts';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const force = await parseRefreshForceFlag(request);
  return Response.json(dispatchAllFeedsRefresh({ force }));
};
