import type { PageServerLoad } from './$types';
import { getWebhooks, parseWebhookEvents } from '#lib/server/webhooks.ts';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) return { webhooks: [] };

  const webhooks = getWebhooks().map((hook) => ({
    ...hook,
    events: parseWebhookEvents(hook.events),
  }));

  return { webhooks };
};
