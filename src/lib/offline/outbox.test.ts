import { describe, expect, it } from 'vitest';
import {
  buildInteractionRequest,
  calculateRetryDelay,
  coalesceMutations,
  requeueBlockedMutations,
  replayMutationBatch,
} from './outbox';
import { mutationDedupeKey } from './state';
import type { OfflineMutation, OfflineMutationType } from './types';

function mutation(
  sequence: number,
  articleId: string,
  type: OfflineMutationType,
  overrides: Partial<OfflineMutation> = {},
): OfflineMutation {
  return {
    id: `mutation-${sequence}-${articleId}-${type}`,
    idempotencyKey: `idempotency-${sequence}`,
    scope: 'test-user',
    articleId,
    type,
    dedupeKey: mutationDedupeKey(articleId, type),
    sequence,
    queuedAt: sequence,
    attempts: 0,
    nextAttemptAt: 0,
    state: 'pending',
    ...overrides,
  };
}

describe('offline mutation outbox', () => {
  it('preserves FIFO order across articles', async () => {
    const sent: string[] = [];
    const result = await replayMutationBatch(
      [
        mutation(3, 'third', 'hide'),
        mutation(1, 'first', 'read'),
        mutation(2, 'second', 'save'),
      ],
      async (item) => {
        sent.push(item.articleId);
        return { ok: true, status: 200 };
      },
      { now: 10 },
    );

    expect(sent).toEqual(['first', 'second', 'third']);
    expect(result.synced).toBe(3);
    expect(result.updated).toEqual([]);
  });

  it('coalesces only the latest state change for each article action group', () => {
    const result = coalesceMutations([
      mutation(1, 'article-1', 'read'),
      mutation(2, 'article-1', 'unread'),
      mutation(3, 'article-1', 'save'),
      mutation(4, 'article-1', 'unsave'),
      mutation(5, 'article-2', 'hide'),
    ]);

    expect(result.map((item) => `${item.articleId}:${item.type}`)).toEqual([
      'article-1:unread',
      'article-1:unsave',
      'article-2:hide',
    ]);
  });

  it('reuses the same mutation record for retries and backs off deterministically', async () => {
    const item = mutation(1, 'article-1', 'save');
    const result = await replayMutationBatch(
      [item],
      async () => ({
        ok: false,
        status: 503,
        error: 'temporarily unavailable',
      }),
      { now: 1_000 },
    );

    expect(result.retried).toBe(1);
    expect(result.stopped).toBe(true);
    expect(result.updated[0]).toMatchObject({
      id: item.id,
      idempotencyKey: item.idempotencyKey,
      attempts: 1,
      state: 'pending',
      nextAttemptAt: 2_000,
    });
    expect(calculateRetryDelay(10)).toBe(300_000);
  });

  it('retains conflicts for explicit resolution instead of dropping user intent', async () => {
    const result = await replayMutationBatch(
      [mutation(1, 'article-1', 'hide')],
      async () => ({ ok: false, status: 409, error: 'server state changed' }),
      { now: 10 },
    );

    expect(result.conflicts).toBe(1);
    expect(result.removedIds).toEqual([]);
    expect(result.updated[0]).toMatchObject({
      state: 'conflict',
      lastError: 'server state changed',
    });
  });

  it('requeues blocked actions with a fresh idempotency key for explicit retry', () => {
    const blocked = mutation(1, 'article-1', 'save', {
      state: 'blocked',
      lastError: 'Unauthorized',
      idempotencyKey: 'stale-key',
    });
    const pending = mutation(2, 'article-2', 'read');
    const conflict = mutation(3, 'article-3', 'hide', {
      state: 'conflict',
      lastError: 'idempotency conflict',
      idempotencyKey: 'conflict-key',
    });
    const result = requeueBlockedMutations([blocked, pending, conflict], 500);

    expect(result[0]).toMatchObject({
      id: blocked.id,
      articleId: 'article-1',
      type: 'save',
      state: 'pending',
      attempts: 0,
      nextAttemptAt: 500,
      lastError: undefined,
    });
    expect(result[0].idempotencyKey).toBe('stale-key');
    expect(result[1]).toEqual(pending);
    expect(result[2]).toMatchObject({ state: 'pending', id: conflict.id });
    expect(result[2].idempotencyKey).not.toBe('conflict-key');
  });

  it('builds a replay request with a stable idempotency identity', () => {
    const item = mutation(1, 'article-1', 'thumbs_down', {
      id: 'mutation-stable',
      idempotencyKey: 'idempotency-stable',
      queuedAt: 12345,
      visibleArticleIds: ['article-1', 'article-2'],
    });
    const request = buildInteractionRequest(item);

    expect(request).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: {
        'X-Offline-Mutation-Id': 'mutation-stable',
        'X-Offline-Idempotency-Key': 'idempotency-stable',
        'X-Offline-Queued-At': '12345',
      },
    });
    expect(request.body).toBe(
      JSON.stringify({
        articleId: 'article-1',
        type: 'thumbs_down',
        queuedAt: 12345,
        visibleArticleIds: ['article-1', 'article-2'],
      }),
    );
  });

  it('replays a reader restore through the versioned interaction contract', () => {
    const request = buildInteractionRequest(
      mutation(1, 'article-1', 'restore', { queuedAt: 67890 }),
    );

    expect(request.body).toBe(
      JSON.stringify({
        articleId: 'article-1',
        type: 'restore',
        queuedAt: 67890,
      }),
    );
    expect(request.headers).toMatchObject({
      'X-Offline-Protocol': 'v1',
      'X-Offline-Idempotency-Key': 'idempotency-1',
      'X-Offline-Queued-At': '67890',
    });
  });

  it('coalesces hide/restore/thumbs_down and thumbs_up/unthumbs_up/boost sequences cleanly', () => {
    const coalesced = coalesceMutations([
      mutation(1, 'article-1', 'hide'),
      mutation(2, 'article-1', 'restore'),
      mutation(3, 'article-2', 'thumbs_down'),
      mutation(4, 'article-2', 'restore'),
      mutation(5, 'article-3', 'thumbs_up'),
      mutation(6, 'article-3', 'unthumbs_up'),
      mutation(7, 'article-4', 'thumbs_up'),
      mutation(8, 'article-4', 'boost'),
    ]);

    expect(coalesced.map((item) => `${item.articleId}:${item.type}`)).toEqual([
      'article-1:restore',
      'article-2:restore',
      'article-3:unthumbs_up',
      'article-4:boost',
    ]);
  });

  it('retains the HTTP status for blocked and conflict actions', async () => {
    const unauthorized = await replayMutationBatch(
      [mutation(1, 'article-1', 'read')],
      async () => ({ ok: false, status: 401, error: 'Unauthorized' }),
      { now: 10 },
    );
    const conflict = await replayMutationBatch(
      [mutation(2, 'article-2', 'hide')],
      async () => ({ ok: false, status: 409, error: 'Conflict' }),
      { now: 10 },
    );

    expect(unauthorized.updated[0]).toMatchObject({
      state: 'blocked',
      blockedStatus: 401,
    });
    expect(conflict.updated[0]).toMatchObject({
      state: 'conflict',
      blockedStatus: 409,
    });
  });

  it('recovers a worker-interrupted processing lease on the next replay', async () => {
    const result = await replayMutationBatch(
      [
        mutation(1, 'article-1', 'read', {
          state: 'processing',
          processingAt: 1,
        }),
      ],
      async () => ({ ok: true, status: 204 }),
      { now: 2 * 60 * 1_000 + 1 },
    );

    expect(result.synced).toBe(1);
    expect(result.updated).toEqual([]);
  });
});
