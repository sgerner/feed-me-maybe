import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  applyArticleState,
  ARTICLE_STATE_ACTIONS,
  ArticleStateError,
  getArticleState,
  getArticleStateCounts,
  getArticleStateHistory,
  type ArticleStateAction,
} from '$lib/server/article-state';

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

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be an object');
  }
  return body as Record<string, unknown>;
}

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });
  const articleId = url.searchParams.get('articleId');
  if (articleId) {
    const state = getArticleState(articleId);
    return state
      ? json({
          articleId,
          state,
          history: getArticleStateHistory({ articleId }),
        })
      : json({ error: 'Article not found' }, { status: 404 });
  }
  return json({
    counts: getArticleStateCounts(url.searchParams.get('feedId') || undefined),
  });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await bodyObject(request);
    const key = body.idempotencyKey;
    if (key !== undefined && (typeof key !== 'string' || key.length > 200)) {
      throw new Error(
        'idempotencyKey must be a string of at most 200 characters',
      );
    }
    const result = applyArticleState({
      articleIds: articleIds(body),
      action: actionFromBody(body),
      idempotencyKey: typeof key === 'string' ? key : undefined,
    });
    return json(result);
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Invalid state change';
    return json(
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
