import { describe, expect, it } from 'vitest';
import {
  buildInteractionRequest,
  calculateRetryDelay,
  coalesceMutations,
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

  it('builds a replay request with a stable idempotency identity', () => {
    const item = mutation(1, 'article-1', 'thumbs_down', {
      id: 'mutation-stable',
      idempotencyKey: 'idempotency-stable',
    });
    const request = buildInteractionRequest(item);

    expect(request).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: {
        'X-Offline-Mutation-Id': 'mutation-stable',
        'X-Offline-Idempotency-Key': 'idempotency-stable',
      },
    });
    expect(request.body).toBe(
      JSON.stringify({ articleId: 'article-1', type: 'thumbs_down' }),
    );
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
