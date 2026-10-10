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

const MAX_VISIBLE_ARTICLE_IDS = 30;
const MAX_ARTICLE_ID_LENGTH = 200;
const REACTION_TYPES = new Set<InteractionType>([
  'thumbs_up',
  'thumbs_down',
  'boost',
]);

function readVisibleArticleIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value.slice(0, MAX_VISIBLE_ARTICLE_IDS * 2)) {
    if (typeof candidate !== 'string') continue;
    const articleId = candidate.trim();
    if (
      !articleId ||
      articleId.length > MAX_ARTICLE_ID_LENGTH ||
      seen.has(articleId)
    ) {
      continue;
    }
    seen.add(articleId);
    ids.push(articleId);
    if (ids.length === MAX_VISIBLE_ARTICLE_IDS) break;
  }
  return ids;
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    const parsedBody: unknown = await request.json();
    if (
      !parsedBody ||
      typeof parsedBody !== 'object' ||
      Array.isArray(parsedBody)
    ) {
      return json({ error: 'Invalid request body' }, { status: 400 });
    }
    body = parsedBody as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }

  const rawArticleId = body.articleId;
  const type = body.type;
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

  if (
    typeof rawArticleId !== 'string' ||
    !rawArticleId.trim() ||
    rawArticleId.length > MAX_ARTICLE_ID_LENGTH ||
    typeof type !== 'string' ||
    !validTypes.includes(type as InteractionType)
  ) {
    return json(
      { error: 'articleId and valid type are required' },
      { status: 400 },
    );
  }
  const articleId = rawArticleId.trim();
  const visibleArticleIds = readVisibleArticleIds(body.visibleArticleIds);

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
        ...(type === 'thumbs_down' ? { visibleArticleIds } : {}),
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

  if (REACTION_TYPES.has(type as InteractionType)) {
    recordInteraction(articleId, type as InteractionType, {
      visibleArticleIds,
    });
  } else {
    recordInteraction(articleId, type as InteractionType);
  }
  return json({ success: true });
};
