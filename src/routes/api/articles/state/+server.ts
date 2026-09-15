import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  applyArticleState,
  ARTICLE_STATE_ACTIONS,
  ArticleStateError,
  type ArticleStateAction,
} from '$lib/server/article-state';

function getErrorResponse(caught: unknown): Response {
  if (caught instanceof ArticleStateError) {
    return json({ error: caught.message }, { status: caught.status });
  }
  return json({ error: 'Failed to update article state' }, { status: 500 });
}

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

  const action = body.action;
  if (
    typeof action !== 'string' ||
    !ARTICLE_STATE_ACTIONS.includes(action as ArticleStateAction)
  ) {
    return json(
      { error: `action must be one of: ${ARTICLE_STATE_ACTIONS.join(', ')}` },
      { status: 400 },
    );
  }

  const suppliedIds = Array.isArray(body.articleIds)
    ? body.articleIds
    : typeof body.articleId === 'string'
      ? [body.articleId]
      : [];
  if (suppliedIds.some((id) => typeof id !== 'string')) {
    return json(
      { error: 'articleIds must be an array of strings' },
      { status: 400 },
    );
  }

  const headerKey = request.headers.get('idempotency-key') || undefined;
  const idempotencyKey =
    typeof body.idempotencyKey === 'string' ? body.idempotencyKey : headerKey;

  try {
    const result = applyArticleState({
      action: action as ArticleStateAction,
      articleIds: suppliedIds as string[],
      idempotencyKey,
    });
    return json(result, { status: result.idempotent ? 200 : 200 });
  } catch (caught) {
    return getErrorResponse(caught);
  }
};
