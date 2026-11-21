<script lang="ts">
  import PullToRefresh from '#lib/components/PullToRefresh.svelte';
  import ArticleList from '#lib/components/ArticleList.svelte';

  import { syncFeeds } from '#lib/feeds.ts';

  type Article = {
    id: string;
    url: string;
    title: string;
    feed_open_mode?: string | null;
  };

  let { data: pageData } = $props<{
    data: {
      articles: Article[];
      initialHasMore: boolean;
      page: number;
      snapshotAt: number;
    };
  }>();

  let articles = $state<Article[]>([]);
  let syncing = $state(false);
  const loadMoreSearchParams = $derived.by(() => {
    const params: Record<string, string> = {
      snapshotAt: String(pageData.snapshotAt),
    };
    if (pageData.category) params.category = pageData.category;
    return params;
  });

  // Count refreshes can replace page data while reusing the loaded articles.
  const loadedArticles = $derived(pageData.articles);

  $effect(() => {
    articles = loadedArticles;
  });

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
  {#key pageData.category}
    {#if pageData.category}
      <h1 class="section-title">{pageData.category}</h1>
    {/if}
    <ArticleList
      bind:articles
      initialHasMore={pageData.initialHasMore}
      initialPage={pageData.page}
      liveUpdates
      {loadMoreSearchParams}
    />
  {/key}
</PullToRefresh>
