import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recordInteractionMock, applyArticleStateMock } = vi.hoisted(() => ({
  recordInteractionMock: vi.fn(),
  applyArticleStateMock: vi.fn(() => ({ updatedCount: 1 })),
}));

vi.mock('$lib/server/interactions', () => ({
  recordInteraction: recordInteractionMock,
}));

vi.mock('$lib/server/article-state', () => ({
  applyArticleState: applyArticleStateMock,
  ArticleStateError: class ArticleStateError extends Error {
    status = 400;
  },
}));

import { POST } from './+server';
import {
  OFFLINE_PROTOCOL_HEADER,
  OFFLINE_PROTOCOL_VERSION,
} from '$lib/server/auth/csrf';

function post(
  body: unknown,
  sessionId: string | null = 'session-1',
  headers: HeadersInit = {},
) {
  return POST({
    request: new Request('http://localhost/api/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    locals: { sessionId },
  } as unknown as Parameters<typeof POST>[0]);
}

describe('interaction API freshness context', () => {
  beforeEach(() => {
    recordInteractionMock.mockClear();
    applyArticleStateMock.mockClear();
  });

  it('passes a normalized, bounded visibility list with reactions', async () => {
    const visibleArticleIds = [
      ' article-2 ',
      '',
      5,
      'article-2',
      ...Array.from({ length: 40 }, (_, index) => `article-${index + 3}`),
    ];
    const response = await post({
      articleId: ' article-1 ',
      type: 'thumbs_down',
      visibleArticleIds,
    });

    expect(response.status).toBe(200);
    expect(recordInteractionMock).toHaveBeenCalledWith(
      'article-1',
      'thumbs_down',
      {
        visibleArticleIds: [
          'article-2',
          ...Array.from({ length: 29 }, (_, index) => `article-${index + 3}`),
        ],
      },
    );
  });

  it('rejects malformed article identifiers before recording an interaction', async () => {
    const response = await post({
      articleId: ['article-1'],
      type: 'thumbs_up',
    });

    expect(response.status).toBe(400);
    expect(recordInteractionMock).not.toHaveBeenCalled();
  });

  it('rejects null and array request bodies', async () => {
    expect((await post(null)).status).toBe(400);
    expect((await post(['article-1', 'thumbs_up'])).status).toBe(400);
    expect(recordInteractionMock).not.toHaveBeenCalled();
  });

  it('forwards offline thumbs_down visibility context through state updates', async () => {
    const visibleArticleIds = Array.from(
      { length: 35 },
      (_, index) => `article-${index + 1}`,
    );
    const response = await post(
      {
        articleId: 'article-1',
        type: 'thumbs_down',
        visibleArticleIds,
      },
      'session-1',
      {
        'x-offline-idempotency-key': 'offline-key',
        [OFFLINE_PROTOCOL_HEADER]: OFFLINE_PROTOCOL_VERSION,
      },
    );

    expect(response.status).toBe(200);
    expect(applyArticleStateMock).toHaveBeenCalledWith({
      articleIds: ['article-1'],
      action: 'reject',
      idempotencyKey: 'offline:offline-key',
      visibleArticleIds: visibleArticleIds.slice(0, 30),
    });
    expect(recordInteractionMock).not.toHaveBeenCalled();
  });
});
