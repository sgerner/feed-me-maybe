import { invalidate } from '$app/navigation';
import { fetchWithCsrf } from '#lib/client/csrf.ts';
import { addToast } from '#lib/stores/toast.svelte.ts';
import {
  applyMutationToCachedArticle,
  cacheArticles,
  enqueueOfflineMutation,
  type OfflineArticle,
  type OfflineMutationType,
} from '#lib/offline/index.ts';

export type TriageAction =
  | 'read'
  | 'unread'
  | 'save'
  | 'unsave'
  | 'hide'
  | 'unhide'
  | 'restore'
  | 'thumbs_up'
  | 'unthumbs_up'
  | 'thumbs_down'
  | 'boost';

export type ArticleStatePayload = {
  read: boolean;
  saved: boolean;
  hidden: boolean;
  thumbsUp: boolean;
  thumbsDown: boolean;
};

const ACTION_LABELS: Record<TriageAction, string> = {
  read: 'Marked as read',
  unread: 'Marked as unread',
  save: 'Saved',
  unsave: 'Removed from Saved',
  hide: 'Hidden',
  unhide: 'Restored',
  restore: 'Restored',
  thumbs_up: 'Liked',
  unthumbs_up: 'Like removed',
  thumbs_down: 'Disliked and hidden',
  boost: 'Boosted and restored',
};

export function toStateAction(action: TriageAction): string {
  return action === 'thumbs_down' ? 'reject' : action;
}

export function toOfflineMutationType(
  action: TriageAction,
): OfflineMutationType {
  return action;
}

export function triageActionLabel(action: TriageAction): string {
  return ACTION_LABELS[action];
}

export function invalidateReaderCounts(): void {
  void invalidate('app:reader-counts');
}

export async function executeArticleTriage(options: {
  articleId: string;
  action: TriageAction;
  scope: string;
  visibleArticleIds?: string[];
  cacheSnapshot?: OfflineArticle;
  onUndo?: () => void | Promise<void>;
}): Promise<{
  mode: 'offline' | 'online';
  operationId?: string;
  changed?: boolean;
  after?: ArticleStatePayload;
}> {
  const { articleId, action, scope, visibleArticleIds, cacheSnapshot, onUndo } =
    options;
  const offlineType = toOfflineMutationType(action);
  const sendVisibility =
    visibleArticleIds?.length &&
    (action === 'thumbs_down' || action === 'thumbs_up' || action === 'boost');

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    await enqueueOfflineMutation(scope, {
      articleId,
      type: offlineType,
      ...(sendVisibility ? { visibleArticleIds } : {}),
    });
    addToast('Action queued — will sync when you’re online', 'info');
    return { mode: 'offline' };
  }

  const res = await fetchWithCsrf('/api/article-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      articleId,
      action: toStateAction(action),
      ...(visibleArticleIds?.length ? { visibleArticleIds } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error('Request failed');
  }

  const result = (await res.json()) as {
    operationId: string;
    changes: Array<{
      changed: boolean;
      after?: ArticleStatePayload;
    }>;
  };
  const change = result.changes[0];
  const after = change?.after;
  const changed = result.changes.some((item) => item.changed);

  if (
    cacheSnapshot &&
    (action === 'save' || action === 'thumbs_up' || action === 'boost')
  ) {
    void cacheArticles(scope, [cacheSnapshot]).catch(() => undefined);
  } else {
    void applyMutationToCachedArticle(scope, articleId, offlineType).catch(
      () => undefined,
    );
  }

  invalidateReaderCounts();

  const label = triageActionLabel(action);
  if (changed && onUndo) {
    addToast(label, 'success', 3000, {
      label: 'Undo',
      run: async () => {
        try {
          const undoRes = await fetchWithCsrf('/api/article-state/undo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ operationId: result.operationId }),
          });
          if (!undoRes.ok) throw new Error('Undo failed');
          const outcome = (await undoRes.json()) as {
            restoredArticleIds: string[];
            conflicts?: string[];
          };
          if (
            outcome.conflicts?.length ||
            !outcome.restoredArticleIds.includes(articleId)
          ) {
            addToast('Article changed since this action', 'warning');
            return;
          }
          await onUndo();
          invalidateReaderCounts();
          addToast('Action undone', 'success');
        } catch {
          addToast('Could not undo this action', 'error');
        }
      },
    });
  } else {
    addToast(label, 'success');
  }

  return {
    mode: 'online',
    operationId: result.operationId,
    changed,
    after,
  };
}

export async function shareArticleLink(
  article: { title: string; url: string },
  copiedMessage = 'Article link copied',
): Promise<void> {
  try {
    if (navigator.share) {
      await navigator.share({ title: article.title, url: article.url });
    } else {
      await navigator.clipboard.writeText(article.url);
      addToast(copiedMessage, 'success');
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    addToast('Could not share this article', 'error');
  }
}
