import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  recordInteraction,
  type InteractionType,
} from '$lib/server/interactions';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { articleId, type } = body as { articleId?: string; type?: string };
  const validTypes: InteractionType[] = [
    'read',
    'hide',
    'save',
    'thumbs_up',
    'thumbs_down',
    'unhide',
    'unsave',
    'open',
  ];

  if (!articleId || !type || !validTypes.includes(type as InteractionType)) {
    return json(
      { error: 'articleId and valid type are required' },
      { status: 400 },
    );
  }

  recordInteraction(articleId, type as InteractionType);
  return json({ success: true });
};
