import { describe, expect, it } from 'vitest';
import {
  applyMutationToArticle,
  matchesOfflineVisibility,
  mutationDedupeKey,
} from './state';

describe('offline article visibility', () => {
  it('hides rejected and hidden articles from ordinary views', () => {
    expect(
      matchesOfflineVisibility({ hidden: false, thumbs_down: false }),
    ).toBe(true);
    expect(matchesOfflineVisibility({ hidden: true, thumbs_down: false })).toBe(
      false,
    );
    expect(matchesOfflineVisibility({ hidden: false, thumbs_down: true })).toBe(
      false,
    );
  });

  it('keeps explicit hidden and rejected views available', () => {
    expect(
      matchesOfflineVisibility({ hidden: true, thumbs_down: false }, 'hidden'),
    ).toBe(true);
    expect(
      matchesOfflineVisibility({ hidden: true, thumbs_down: true }, 'rejected'),
    ).toBe(true);
  });

  it('restores hidden and rejected cached articles and coalesces rejection intent', () => {
    const restored = applyMutationToArticle(
      {
        id: 'article-1',
        url: 'https://example.com/story',
        title: 'Story',
        hidden: true,
        thumbs_down: true,
      },
      'restore',
    );

    expect(restored).toMatchObject({ hidden: false, thumbs_down: false });
    expect(mutationDedupeKey('article-1', 'restore')).toBe('article-1:hide');
    expect(mutationDedupeKey('article-1', 'restore')).toBe(
      mutationDedupeKey('article-1', 'hide'),
    );
    expect(mutationDedupeKey('article-1', 'restore')).toBe(
      mutationDedupeKey('article-1', 'thumbs_down'),
    );
  });

  it('applies thumbs_up, unthumbs_up, boost, and unread offline mutations and groups dedupe keys', () => {
    const base = {
      id: 'article-1',
      url: 'https://example.com/story',
      title: 'Story',
      read: true,
      hidden: true,
      thumbs_up: false,
      thumbs_down: true,
    };

    expect(applyMutationToArticle(base, 'unread')).toMatchObject({
      read: false,
    });
    const liked = applyMutationToArticle(base, 'thumbs_up');
    expect(liked).toMatchObject({ thumbs_up: true, thumbs_down: false });
    expect(applyMutationToArticle(liked, 'unthumbs_up')).toMatchObject({
      thumbs_up: false,
    });
    expect(applyMutationToArticle(base, 'boost')).toMatchObject({
      thumbs_up: true,
      thumbs_down: false,
      hidden: false,
    });

    expect(mutationDedupeKey('article-1', 'thumbs_up')).toBe(
      mutationDedupeKey('article-1', 'unthumbs_up'),
    );
    expect(mutationDedupeKey('article-1', 'thumbs_up')).toBe(
      mutationDedupeKey('article-1', 'boost'),
    );
    expect(mutationDedupeKey('article-1', 'read')).toBe(
      mutationDedupeKey('article-1', 'unread'),
    );
  });
});
