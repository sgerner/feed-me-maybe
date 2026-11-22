<script lang="ts">
  import PullToRefresh from '#lib/components/PullToRefresh.svelte';
  import ArticleList from '#lib/components/ArticleList.svelte';
  import { goto } from '$app/navigation';
  import { page as pageStore } from '$app/state';
  import { syncFeeds } from '#lib/feeds.ts';

  type ArticleSort = 'ranked' | 'newest' | 'oldest';
  type Article = {
    id: string;
    url: string;
    title: string;
    feed_open_mode?: string | null;
  };

  const SORT_OPTIONS: Array<{ value: ArticleSort; label: string }> = [
    { value: 'ranked', label: 'Ranked' },
    { value: 'newest', label: 'Newest' },
    { value: 'oldest', label: 'Oldest' },
  ];

  let { data: pageData } = $props<{
    data: {
      category?: string;
      sort?: ArticleSort;
      articles: Article[];
      initialHasMore: boolean;
      page: number;
      snapshotAt: number;
    };
  }>();

  let articles = $state<Article[]>([]);
  let syncing = $state(false);
  const currentSort = $derived<ArticleSort>(pageData.sort || 'ranked');
  const loadMoreSearchParams = $derived.by(() => {
    const params: Record<string, string> = {
      snapshotAt: String(pageData.snapshotAt),
    };
    if (pageData.category) params.category = pageData.category;
    if (currentSort !== 'ranked') params.sort = currentSort;
    return params;
  });

  // Count refreshes can replace page data while reusing the loaded articles.
  const loadedArticles = $derived(pageData.articles);
  let lastLoadedArticles: Article[] | null = null;

  $effect(() => {
    if (loadedArticles !== lastLoadedArticles) {
      lastLoadedArticles = loadedArticles;
      articles = loadedArticles;
    }
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

  async function handleSync() {
    if (syncing) return;
    syncing = true;
    try {
      await syncFeeds();
    } finally {
      syncing = false;
    }
  }
</script>

<svelte:head>
  <title>{pageData.category || 'All Articles'} · Feed Me Maybe</title>
</svelte:head>

{#if !pageData.category}<h1 class="sr-only">All Articles</h1>{/if}

<PullToRefresh onSync={handleSync} {syncing} mobileOnly>
  <div
    class="-mx-3 -mt-2 mb-0 flex flex-wrap items-center justify-between gap-2 border-b px-3 md:mx-0 md:mt-0 md:mb-5 md:px-0"
    style="border-color: color-mix(in oklch, var(--color-surface-100) 8%, transparent);"
  >
    {#if pageData.category}
      <h1 class="section-title py-1.5">{pageData.category}</h1>
    {/if}
    <div class="feed-sort-tabs" role="group" aria-label="Sort articles">
      {#each SORT_OPTIONS as option (option.value)}
        <button
          type="button"
          class="feed-sort-tab"
          class:feed-sort-tab-active={currentSort === option.value}
          aria-pressed={currentSort === option.value}
          onclick={() => setSort(option.value)}>{option.label}</button
        >
      {/each}
    </div>
  </div>
  {#key `${pageData.category || ''}:${currentSort}`}
    <ArticleList
      bind:articles
      initialHasMore={pageData.initialHasMore}
      initialPage={pageData.page}
      liveUpdates
      {loadMoreSearchParams}
    />
  {/key}
</PullToRefresh>
