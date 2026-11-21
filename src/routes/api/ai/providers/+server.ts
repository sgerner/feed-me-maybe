import type { RequestHandler } from './$types';
import { getProviders } from '#lib/server/ai/models-dev.ts';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const providers = await getProviders();
    return Response.json({ providers });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
};
