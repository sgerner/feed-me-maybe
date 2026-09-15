import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ArticleStateError, undoArticleState } from '$lib/server/article-state';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId)
    return json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Request body must be an object');
    }
    const values = body as Record<string, unknown>;
    const operationId = values.operationId;
    const idempotencyKey = values.idempotencyKey;
    if (
      (operationId !== undefined && typeof operationId !== 'string') ||
      (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') ||
      (typeof operationId !== 'string' && typeof idempotencyKey !== 'string')
    ) {
      return json(
        { error: 'operationId or idempotencyKey is required' },
        { status: 400 },
      );
    }
    return json(
      undoArticleState({
        operationId: operationId as string | undefined,
        idempotencyKey: idempotencyKey as string | undefined,
      }),
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Undo failed';
    return json(
      { error: message },
      {
        status:
          error instanceof ArticleStateError && error.status
            ? error.status
            : message.includes('not found')
              ? 404
              : 400,
      },
    );
  }
};
