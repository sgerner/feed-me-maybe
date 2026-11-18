<script lang="ts">
  import PullToRefresh from '$lib/components/PullToRefresh.svelte';
  import ArticleList from '$lib/components/ArticleList.svelte';

  import { syncFeeds } from '$lib/feeds';

  type Article = {
    id: string;
    url: string;
    title: string;
    feed_open_mode?: string | null;
  };

  let { data: pageData } = $props<{
    data: { articles: Article[]; totalPages: number };
  }>();

  let articles = $state<Article[]>([]);
  let syncing = $state(false);

  $effect(() => {
    articles = pageData.articles;
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
  <title>All Articles · Feed Me Maybe</title>
</svelte:head>

<h1 class="sr-only">All Articles</h1>

<PullToRefresh onSync={handleSync} {syncing} mobileOnly>
  <ArticleList bind:articles totalPages={pageData.totalPages} />
</PullToRefresh>
