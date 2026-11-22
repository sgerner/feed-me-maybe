import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  fetchWithCsrf: vi.fn(),
  addToast: vi.fn(),
  enqueueOfflineMutation: vi.fn(),
  applyMutationToCachedArticle: vi.fn(async () => undefined),
  cacheArticles: vi.fn(async () => undefined),
}));

vi.mock('$app/navigation', () => ({ invalidate: mocks.invalidate }));
vi.mock('#lib/client/csrf.ts', () => ({ fetchWithCsrf: mocks.fetchWithCsrf }));
vi.mock('#lib/stores/toast.svelte.ts', () => ({ addToast: mocks.addToast }));
vi.mock('#lib/offline/index.ts', () => ({
  enqueueOfflineMutation: mocks.enqueueOfflineMutation,
  applyMutationToCachedArticle: mocks.applyMutationToCachedArticle,
  cacheArticles: mocks.cacheArticles,
}));

import {
  executeArticleTriage,
  shareArticleLink,
  toOfflineMutationType,
  toStateAction,
  triageActionLabel,
} from './triage';

describe('shared client triage helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('navigator', { onLine: true });
  });

  it('maps triage actions to server state actions, offline types, and labels', () => {
    expect(toStateAction('thumbs_down')).toBe('reject');
    expect(toStateAction('unthumbs_up')).toBe('unthumbs_up');
    expect(toStateAction('unread')).toBe('unread');
    expect(toOfflineMutationType('boost')).toBe('boost');
    expect(toOfflineMutationType('unthumbs_up')).toBe('unthumbs_up');
    expect(triageActionLabel('unread')).toBe('Marked as unread');
    expect(triageActionLabel('unthumbs_up')).toBe('Like removed');
  });

  it('queues offline mutations when disconnected without calling fetch', async () => {
    vi.stubGlobal('navigator', { onLine: false });

    const result = await executeArticleTriage({
      articleId: 'a-1',
      action: 'thumbs_up',
      scope: 'user-1',
      visibleArticleIds: ['a-1', 'a-2'],
    });

    expect(result).toEqual({ mode: 'offline' });
    expect(mocks.fetchWithCsrf).not.toHaveBeenCalled();
    expect(mocks.enqueueOfflineMutation).toHaveBeenCalledWith('user-1', {
      articleId: 'a-1',
      type: 'thumbs_up',
      visibleArticleIds: ['a-1', 'a-2'],
    });
    expect(mocks.addToast).toHaveBeenCalledWith(
      'Action queued — will sync when you’re online',
      'info',
    );
  });

  it('executes online state mutation, updates cache, invalidates counts, and supports undo', async () => {
    const onUndo = vi.fn();
    mocks.fetchWithCsrf
      .mockResolvedValueOnce(
        Response.json({
          operationId: 'op-1',
          changes: [{ changed: true, after: { read: false } }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ restoredArticleIds: ['a-1'], conflicts: [] }),
      );

    const result = await executeArticleTriage({
      articleId: 'a-1',
      action: 'unread',
      scope: 'user-1',
      onUndo,
    });

    expect(result.mode).toBe('online');
    expect(result.operationId).toBe('op-1');
    expect(mocks.applyMutationToCachedArticle).toHaveBeenCalledWith(
      'user-1',
      'a-1',
      'unread',
    );
    expect(mocks.invalidate).toHaveBeenCalledWith('app:reader-counts');
    expect(mocks.addToast).toHaveBeenCalledWith(
      'Marked as unread',
      'success',
      3000,
      expect.objectContaining({ label: 'Undo' }),
    );

    const undoAction = mocks.addToast.mock.calls[0]?.[3] as {
      run: () => Promise<void>;
    };
    await undoAction.run();
    expect(onUndo).toHaveBeenCalledOnce();
    expect(mocks.invalidate).toHaveBeenCalledTimes(2);
    expect(mocks.addToast).toHaveBeenLastCalledWith('Action undone', 'success');
  });

  it('copies article link via clipboard when navigator.share is unavailable', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { onLine: true, clipboard: { writeText } });

    await shareArticleLink(
      { title: 'Title', url: 'https://example.com/a' },
      'Link copied',
    );

    expect(writeText).toHaveBeenCalledWith('https://example.com/a');
    expect(mocks.addToast).toHaveBeenCalledWith('Link copied', 'success');
  });
});
