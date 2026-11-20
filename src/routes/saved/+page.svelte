<script lang="ts">
  import { page } from '$app/state';
  import ArticleList from '$lib/components/ArticleList.svelte';
  import { cacheSavedArticles, type OfflineArticle } from '$lib/offline';

  let { data } = $props<{ data: { articles: OfflineArticle[] } }>();
  let articles = $state<OfflineArticle[]>([]);

  // Count refreshes can replace page data while reusing the loaded articles.
  const loadedArticles = $derived(data.articles);

  $effect(() => {
    articles = loadedArticles;
  });

  $effect(() => {
    if (page.data.sessionId && navigator.onLine !== false) {
      void cacheSavedArticles(
        String(page.data.userId || 'admin'),
        data.articles,
      ).catch(() => undefined);
    }
  });
</script>

<svelte:head>
  <title>Saved Articles · Feed Me Maybe</title>
</svelte:head>

<div class="mx-auto max-w-7xl">
  <div class="mb-8">
    <h1 class="section-title">Saved</h1>
    <p class="section-subtitle">
      {articles.length} saved {articles.length === 1 ? 'article' : 'articles'}
    </p>
  </div>
  <ArticleList
    bind:articles
    totalPages={1}
    showInfiniteScroll={false}
    savedOnly
    emptyTitle="No saved articles"
    emptyMessage="Save an article to read it later."
    emptyCtaHref={null}
  />
</div>
