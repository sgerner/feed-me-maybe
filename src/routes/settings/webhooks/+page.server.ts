import type { PageServerLoad } from './$types';
import { getWebhooks } from '$lib/server/webhooks';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) return { webhooks: [] };
  
  const webhooks = getWebhooks().map(hook => ({
    ...hook,
    events: JSON.parse(hook.events)
  }));
  
  return { webhooks };
};
