<script lang="ts">
  import { onMount } from 'svelte';
  import ArticleList from '$lib/components/ArticleList.svelte';
  import { getCachedArticles } from '$lib/offline';

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

  let {
    data,
  }: {
    data: { articles: Article[]; totalPages: number; totalArticles: number };
  } = $props();
  let articles = $state<Article[]>([]);

  $effect(() => {
    articles = data.articles;
  });

  onMount(() => {
    if (navigator.onLine !== false || articles.length > 0) return;
    void getCachedArticles('admin', { limit: 150 })
      .then((cached) => {
        if (articles.length === 0) {
          articles = cached.filter(
            (article) =>
              article.read !== true &&
              article.hidden !== true &&
              article.thumbs_down !== true,
          );
        }
      })
      .catch(() => undefined);
  });
</script>

<svelte:head>
  <title>Inbox · Feed Me Maybe</title>
  <meta name="description" content="Your calm unread reading queue." />
</svelte:head>

<div class="mx-auto max-w-7xl">
  <div
    class="mb-8 flex flex-col gap-3 md:flex-row md:items-end md:justify-between"
  >
    <div>
      <p class="eyebrow text-primary-300">Unread</p>
      <h1 class="section-title">Inbox</h1>
      <p class="section-subtitle">
        {data.totalArticles} unread {data.totalArticles === 1
          ? 'story'
          : 'stories'}.
      </p>
    </div>
    <a href="/search?q=is%3Aunread" class="btn preset-tonal no-underline"
      >Search unread</a
    >
  </div>

  <ArticleList
    bind:articles
    totalPages={data.totalPages}
    loadMoreSearchParams={{ unread: '1' }}
    emptyTitle="No unread stories"
    emptyMessage="You are all caught up."
    emptyCtaHref="/"
    emptyCtaLabel="Browse all stories"
  />
</div>
