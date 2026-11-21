import type { RequestHandler } from './$types';
import {
  ArticleStateError,
  undoArticleState,
} from '#lib/server/article-state.ts';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const result = undoArticleState({
      operationId:
        typeof body.operationId === 'string' ? body.operationId : undefined,
      idempotencyKey:
        typeof body.idempotencyKey === 'string'
          ? body.idempotencyKey
          : request.headers.get('idempotency-key') || undefined,
    });
    return Response.json(result);
  } catch (caught) {
    if (caught instanceof ArticleStateError) {
      return Response.json(
        { error: caught.message },
        { status: caught.status },
      );
    }
    return Response.json(
      { error: 'Failed to undo article state' },
      { status: 500 },
    );
  }
};
