import type { OfflineArticle, OfflineMutationType } from './types';

export function mutationDedupeKey(
  articleId: string,
  type: OfflineMutationType,
): string {
  const group =
    type === 'read' || type === 'unread'
      ? 'read'
      : type === 'save' || type === 'unsave'
        ? 'save'
        : type === 'hide' || type === 'unhide'
          ? 'hide'
          : 'thumbs_down';
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
      return { ...article, hidden: false };
    case 'thumbs_down':
      return {
        ...article,
        thumbs_down: true,
        thumbs_up: false,
        hidden: true,
      };
  }
}
