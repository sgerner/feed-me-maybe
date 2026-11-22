<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page as pageStore } from '$app/state';
  import PullToRefresh from '#lib/components/PullToRefresh.svelte';
  import ArticleList from '#lib/components/ArticleList.svelte';
  import { syncFeeds } from '#lib/feeds.ts';
  import { getCachedArticles } from '#lib/offline/index.ts';

  type ArticleSort = 'ranked' | 'newest' | 'oldest';
  type Article = {
    id: string;
    url: string;
    title: string;
    summary?: string | null;
    image_url?: string | null;
    published_at?: number | null;
    fetched_at?: number | null;
    feed_title?: string | null;
    feed_open_mode?: string | null;
    feed_url?: string | null;
    saved?: boolean | null;
    hidden?: boolean | null;
    thumbs_up?: boolean | null;
    thumbs_down?: boolean | null;
  };

  const SORT_OPTIONS: Array<{ value: ArticleSort; label: string }> = [
    { value: 'ranked', label: 'Ranked' },
    { value: 'newest', label: 'Newest' },
    { value: 'oldest', label: 'Oldest' },
  ];

  let {
    data,
  }: {
    data: {
      articles: Article[];
      totalPages: number;
      totalArticles: number;
      category: string;
      sort?: ArticleSort;
      snapshotAt: number;
    };
  } = $props();
  let articles = $state<Article[]>([]);
  let liveUnreadArticleIds = $state<string[]>([]);
  let snapshotCountDelta = $state(0);
  let baseUnreadCount = $state(0);
  let syncing = $state(false);
  let unreadCount = $derived(
    Math.max(
      0,
      baseUnreadCount + snapshotCountDelta + liveUnreadArticleIds.length,
    ),
  );
  let unreadSnapshotAt = $state(0);
  let lastLoadedArticles: Article[] | null = null;
  const openAddFeed = getContext<(() => void) | undefined>('openAddFeed');
  const totalFeedsCount = $derived(
    Number(pageStore.data.totalFeeds ?? (pageStore.data.feeds?.length || 0)),
  );
  const pausedFeedsCount = $derived(Number(pageStore.data.pausedFeeds ?? 0));
  const activeFeedsCount = $derived(
    Math.max(0, totalFeedsCount - pausedFeedsCount),
  );
  const activeCategoryFeedsCount = $derived.by(() => {
    if (!data.category) return activeFeedsCount;
    const activeFeeds = Array.isArray(pageStore.data.feeds)
      ? pageStore.data.feeds
      : [];
    return activeFeeds.filter(
      (feed: { category?: string | null }) =>
        (feed.category?.trim() || '') === data.category,
    ).length;
  });
  const inboxPausedEmpty = $derived(
    totalFeedsCount > 0 &&
      (activeFeedsCount === 0 ||
        (Boolean(data.category) &&
          activeCategoryFeedsCount === 0 &&
          pausedFeedsCount > 0)),
  );
  const currentSort = $derived<ArticleSort>(data.sort || 'ranked');
  const loadMoreSearchParams = $derived.by(() => {
    const params: Record<string, string> = {
      unread: '1',
      snapshotAt: String(data.snapshotAt),
    };
    if (data.category) params.category = data.category;
    if (currentSort !== 'ranked') params.sort = currentSort;
    return params;
  });

  function setSort(nextSort: ArticleSort) {
    const next = new URL(pageStore.url.href);
    if (nextSort === 'ranked') {
      next.searchParams.delete('sort');
    } else {
      next.searchParams.set('sort', nextSort);
    }
    next.searchParams.delete('page');
    void goto(`${next.pathname}${next.search}`, { reset: false });
  }

  // Count refreshes can replace page data while reusing the loaded articles.
  const loadedArticles = $derived(data.articles);

  $effect(() => {
    if (loadedArticles === lastLoadedArticles) return;
    lastLoadedArticles = loadedArticles;
    if (data.snapshotAt !== unreadSnapshotAt) {
      unreadSnapshotAt = data.snapshotAt;
      liveUnreadArticleIds = [];
      snapshotCountDelta = 0;
    }
    baseUnreadCount = data.totalArticles;
    articles = loadedArticles;
  });

  function addLiveUnreadArticles(articleIds: string[]): void {
    liveUnreadArticleIds = Array.from(
      new Set([...liveUnreadArticleIds, ...articleIds]),
    );
  }

  function updateLiveUnreadVisibility(
    articleId: string,
    visible: boolean,
  ): void {
    liveUnreadArticleIds = visible
      ? Array.from(new Set([...liveUnreadArticleIds, articleId]))
      : liveUnreadArticleIds.filter((id) => id !== articleId);
  }

  function applySnapshotCountDelta(delta: number): void {
    snapshotCountDelta += delta;
  }

  async function handleSync() {
    if (syncing) return;
    syncing = true;
    try {
      await syncFeeds();
    } finally {
      syncing = false;
    }
  }

  onMount(() => {
    if (navigator.onLine !== false || articles.length > 0) return;
    void getCachedArticles(String(pageStore.data.userId || 'admin'), {
      limit: 150,
    })
      .then((cached) => {
        if (articles.length === 0) {
          const unread = cached.filter(
            (article) =>
              article.read !== true &&
              article.hidden !== true &&
              article.thumbs_down !== true,
          );
          articles = unread;
          baseUnreadCount = unread.length;
        }
      })
      .catch(() => undefined);
  });
</script>

<svelte:head>
  <title>Inbox · Feed Me Maybe</title>
  <meta name="description" content="Your calm unread reading queue." />
</svelte:head>

<PullToRefresh onSync={handleSync} {syncing} mobileOnly>
  <div
    class="mb-8 flex flex-col gap-3 md:flex-row md:items-end md:justify-between"
  >
    <div>
      <p class="eyebrow text-primary-300">Unread</p>
      <h1 class="section-title">
        {data.category ? `${data.category} inbox` : 'Inbox'}
      </h1>
      <p class="section-subtitle">
        {unreadCount} unread {unreadCount === 1 ? 'story' : 'stories'}.
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <div
        class="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label="Sort unread stories"
      >
        {#each SORT_OPTIONS as option (option.value)}
          <button
            type="button"
            class="rounded-full border px-3 py-1.5 text-xs font-semibold transition {currentSort ===
            option.value
              ? 'border-primary-400/40 bg-primary-500/15 text-primary-200'
              : 'border-white/10 bg-white/5 text-surface-300 hover:border-white/20 hover:text-surface-200'}"
            aria-pressed={currentSort === option.value}
            onclick={() => setSort(option.value)}>{option.label}</button
          >
        {/each}
      </div>
      <a href="/search?q=is%3Aunread" class="btn preset-tonal no-underline"
        >Search unread</a
      >
    </div>
  </div>

  {#key `${data.category}:${currentSort}`}
    <ArticleList
      bind:articles
      totalPages={data.totalPages}
      liveUpdates
      onLiveArticlesAdded={addLiveUnreadArticles}
      onLiveArticleVisibilityChanged={updateLiveUnreadVisibility}
      onSnapshotCountDelta={applySnapshotCountDelta}
      {loadMoreSearchParams}
      emptyTitle={totalFeedsCount === 0
        ? 'No feeds yet'
        : inboxPausedEmpty
          ? 'All feeds are paused'
          : 'No unread stories'}
      emptyMessage={totalFeedsCount === 0
        ? 'Add an RSS, website, or Reddit feed to start building your reading queue.'
        : inboxPausedEmpty
          ? 'Resume a paused feed or add a new source to receive unread stories.'
          : pausedFeedsCount > 0
            ? 'You are all caught up on active feeds. Resume paused feeds anytime on Feeds.'
            : 'You are all caught up.'}
      emptyCtaAction={totalFeedsCount === 0 && openAddFeed ? openAddFeed : null}
      emptyCtaHref={totalFeedsCount === 0 && openAddFeed ? null : '/feeds'}
      emptyCtaLabel={totalFeedsCount === 0 ? 'Add feed' : 'Manage feeds'}
    />
  {/key}
</PullToRefresh>
