import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  recordInteraction,
  type InteractionType,
} from '$lib/server/interactions';
import {
  applyArticleState,
  ArticleStateError,
  type ArticleStateAction,
} from '$lib/server/article-state';
import {
  OFFLINE_PROTOCOL_HEADER,
  OFFLINE_PROTOCOL_VERSION,
} from '$lib/server/auth/csrf';

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
    'unread',
    'hide',
    'save',
    'thumbs_up',
    'thumbs_down',
    'boost',
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

  // The service worker replays mutations through this compatibility endpoint
  // so older clients and the installed PWA share one queue contract. Route
  // those requests through the versioned state API for exactly-once behavior.
  const offlineKey = request.headers.get('x-offline-idempotency-key');
  if (
    offlineKey &&
    request.headers.get(OFFLINE_PROTOCOL_HEADER) === OFFLINE_PROTOCOL_VERSION
  ) {
    const actions: Partial<Record<InteractionType, ArticleStateAction>> = {
      read: 'read',
      unread: 'unread',
      save: 'save',
      unsave: 'unsave',
      hide: 'hide',
      unhide: 'unhide',
      thumbs_down: 'reject',
    };
    const action = actions[type as InteractionType];
    if (!action) {
      return json(
        { error: 'Unsupported offline interaction' },
        { status: 400 },
      );
    }
    try {
      const result = applyArticleState({
        articleIds: [articleId],
        action,
        idempotencyKey: `offline:${offlineKey}`,
      });
      return json({ success: true, ...result });
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'State update failed';
      return json(
        { error: message },
        { status: caught instanceof ArticleStateError ? caught.status : 400 },
      );
    }
  }

  recordInteraction(articleId, type as InteractionType);
  return json({ success: true });
};
