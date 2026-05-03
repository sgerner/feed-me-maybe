import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getProviders } from '$lib/server/ai/models-dev';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const providers = await getProviders();
    return json({ providers });
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};
