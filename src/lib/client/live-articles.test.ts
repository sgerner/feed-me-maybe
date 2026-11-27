import { describe, expect, it } from 'vitest';
import { extractLiveArticleIds, mergeLiveArticles } from './live-articles';

describe('live article event extraction', () => {
  it('filters valid IDs and skips broadcasts for unrelated feeds', () => {
    expect(
      extractLiveArticleIds({ ids: ['a-1', '', 42, 'a-2'] }, null),
    ).toEqual(['a-1', 'a-2']);

    expect(
      extractLiveArticleIds({ ids: ['a-1'], feedId: 'feed-2' }, 'feed-1'),
    ).toEqual([]);

    expect(
      extractLiveArticleIds({ ids: ['a-1'], feedId: 'feed-1' }, 'feed-1'),
    ).toEqual(['a-1']);

    // Events without feedId still pass through for server-side feedId filtering.
    expect(extractLiveArticleIds({ ids: ['a-1'] }, 'feed-1')).toEqual(['a-1']);
    expect(extractLiveArticleIds(null, 'feed-1')).toEqual([]);
  });

  it('rejects IDs exceeding 128 characters', () => {
    const overlong = 'x'.repeat(129);
    expect(extractLiveArticleIds({ ids: [overlong, 'ok'] })).toEqual(['ok']);
  });
});

describe('live article merging', () => {
  it('prepends deduplicated articles and tracks post-snapshot additions', () => {
    const existing = [
      { id: 'a-2', fetched_at: 1000 },
      { id: 'a-1', fetched_at: 900 },
    ];
    const incoming = [
      { id: 'a-4', fetched_at: 1200 },
      { id: 'a-3', fetched_at: 1100 },
      { id: 'a-2', fetched_at: 1000 },
      { id: 'a-4', fetched_at: 1200 },
    ];

    const result = mergeLiveArticles({
      existingArticles: existing,
      incomingArticles: incoming,
      snapshotAt: 1050,
      focusedIndex: 1,
      preserveFocusedArticle: true,
    });

    expect(result.articles.map((a) => a.id)).toEqual([
      'a-4',
      'a-3',
      'a-2',
      'a-1',
    ]);
    expect(result.newArticles.map((a) => a.id)).toEqual(['a-4', 'a-3']);
    expect(result.addedAfterSnapshot).toEqual(['a-4', 'a-3']);
    expect(result.focusedIndex).toBe(3);
  });

  it('keeps focusedIndex at 0 when list was empty or focus was not anchored', () => {
    const emptyResult = mergeLiveArticles({
      existingArticles: [],
      incomingArticles: [
        { id: 'a-2', fetched_at: 200 },
        { id: 'a-1', fetched_at: 150 },
      ],
      snapshotAt: 100,
      focusedIndex: 0,
      preserveFocusedArticle: true,
    });
    expect(emptyResult.focusedIndex).toBe(0);

    const unanchoredResult = mergeLiveArticles({
      existingArticles: [{ id: 'a-0', fetched_at: 50 }],
      incomingArticles: [{ id: 'a-1', fetched_at: 150 }],
      snapshotAt: 100,
      focusedIndex: 0,
      preserveFocusedArticle: false,
    });
    expect(unanchoredResult.focusedIndex).toBe(0);
  });

  it('returns existing array unchanged when all incoming articles are duplicates', () => {
    const existing = [{ id: 'a-1', fetched_at: 100 }];
    const result = mergeLiveArticles({
      existingArticles: existing,
      incomingArticles: [{ id: 'a-1', fetched_at: 100 }],
      snapshotAt: 50,
      focusedIndex: 0,
    });

    expect(result.articles).toBe(existing);
    expect(result.newArticles).toEqual([]);
    expect(result.addedAfterSnapshot).toEqual([]);
    expect(result.focusedIndex).toBe(0);
  });
});
