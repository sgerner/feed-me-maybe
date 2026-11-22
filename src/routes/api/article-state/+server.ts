import type { RequestHandler } from './$types';
import { readJsonObject } from '#lib/server/request-body.ts';
import {
  applyArticleState,
  ARTICLE_STATE_ACTIONS,
  ArticleStateError,
  type ArticleStateAction,
} from '#lib/server/article-state.ts';

function actionFromBody(body: Record<string, unknown>): ArticleStateAction {
  if (typeof body.action === 'string') {
    if (!ARTICLE_STATE_ACTIONS.includes(body.action as ArticleStateAction)) {
      throw new ArticleStateError('Unsupported article state action');
    }
    return body.action as ArticleStateAction;
  }

  // Accept the more declarative shape for API consumers while keeping each
  // operation atomic and easy to replay: { state: { read: true } }.
  const state = body.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new ArticleStateError('action is required');
  }
  const entries = Object.entries(state as Record<string, unknown>);
  if (entries.length !== 1) {
    throw new ArticleStateError('state must contain exactly one field');
  }
  const [field, value] = entries[0];
  if (typeof value !== 'boolean') {
    throw new ArticleStateError(`${field} must be a boolean`);
  }
  const actions: Record<string, ArticleStateAction> = {
    read: value ? 'read' : 'unread',
    saved: value ? 'save' : 'unsave',
    hidden: value ? 'hide' : 'unhide',
    rejected: value ? 'reject' : 'unreject',
    thumbsUp: value ? 'thumbs_up' : 'unthumbs_up',
    thumbs_up: value ? 'thumbs_up' : 'unthumbs_up',
  };
  const action = actions[field];
  if (!action) throw new ArticleStateError(`Unsupported state field: ${field}`);
  return action;
}

function articleIds(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.articleIds)) {
    return body.articleIds.filter((id): id is string => typeof id === 'string');
  }
  return typeof body.articleId === 'string' ? [body.articleId] : [];
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await readJsonObject(request);
  if (!body) {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  try {
    const headerKey = request.headers.get('idempotency-key') || undefined;
    const key = body.idempotencyKey ?? headerKey;
    if (key !== undefined && (typeof key !== 'string' || key.length > 200)) {
      throw new Error(
        'idempotencyKey must be a string of at most 200 characters',
      );
    }
    const queuedAt =
      typeof body.queuedAt === 'number' && Number.isFinite(body.queuedAt)
        ? body.queuedAt
        : undefined;
    const result = applyArticleState({
      articleIds: articleIds(body),
      action: actionFromBody(body),
      visibleArticleIds: body.visibleArticleIds,
      idempotencyKey: typeof key === 'string' ? key : undefined,
      queuedAt,
    });
    return Response.json(result);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Invalid state change';
    return Response.json(
      { error: message },
      {
        status:
          error instanceof ArticleStateError && error.status
            ? error.status
            : message === 'Article not found'
              ? 404
              : 400,
      },
    );
  }
};
