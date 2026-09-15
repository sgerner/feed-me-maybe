import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ArticleStateError, undoArticleState } from '$lib/server/article-state';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    return json({ error: 'Invalid request body' }, { status: 400 });
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
    return json(result);
  } catch (caught) {
    if (caught instanceof ArticleStateError) {
      return json({ error: caught.message }, { status: caught.status });
    }
    return json({ error: 'Failed to undo article state' }, { status: 500 });
  }
};
