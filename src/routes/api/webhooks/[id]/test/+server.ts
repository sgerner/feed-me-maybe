import type { RequestHandler } from './$types';
import { testWebhook, WebhookNotFoundError } from '#lib/server/webhooks.ts';

export const POST: RequestHandler = async ({ params, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const id = params.id?.trim();
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }

  try {
    const result = await testWebhook(id);
    return Response.json(result);
  } catch (err: any) {
    if (err instanceof WebhookNotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    return Response.json(
      {
        ok: false,
        status: null,
        durationMs: 0,
        error: err instanceof Error ? err.message : 'Webhook test failed',
      },
      { status: 500 },
    );
  }
};
