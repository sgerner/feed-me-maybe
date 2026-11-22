import type { OfflineArticle, OfflineMutationType } from './types';

export type OfflineVisibilityFilter = 'visible' | 'hidden' | 'rejected';

export function matchesOfflineVisibility(
  article: Pick<OfflineArticle, 'hidden' | 'thumbs_down'>,
  filter: OfflineVisibilityFilter = 'visible',
): boolean {
  if (filter === 'hidden') return article.hidden === true;
  if (filter === 'rejected') return article.thumbs_down === true;
  return article.hidden !== true && article.thumbs_down !== true;
}

export function mutationDedupeKey(
  articleId: string,
  type: OfflineMutationType,
): string {
  const group =
    type === 'read' || type === 'unread'
      ? 'read'
      : type === 'save' || type === 'unsave'
        ? 'save'
        : type === 'hide' ||
            type === 'unhide' ||
            type === 'restore' ||
            type === 'thumbs_down'
          ? 'hide'
          : 'thumbs_up';
  return `${articleId}:${group}`;
}

export function applyMutationToArticle(
  article: OfflineArticle,
  type: OfflineMutationType,
): OfflineArticle {
  switch (type) {
    case 'read':
      return { ...article, read: true };
    case 'unread':
      return { ...article, read: false };
    case 'save':
      return { ...article, saved: true };
    case 'unsave':
      return { ...article, saved: false };
    case 'hide':
      return { ...article, hidden: true };
    case 'unhide':
      return { ...article, hidden: false, thumbs_down: false };
    case 'thumbs_up':
      return { ...article, thumbs_up: true, thumbs_down: false };
    case 'unthumbs_up':
      return { ...article, thumbs_up: false };
    case 'boost':
      return {
        ...article,
        thumbs_up: true,
        thumbs_down: false,
        hidden: false,
      };
    case 'thumbs_down':
      return {
        ...article,
        thumbs_down: true,
        thumbs_up: false,
        hidden: true,
      };
    case 'restore':
      return { ...article, thumbs_down: false, hidden: false };
  }
}
