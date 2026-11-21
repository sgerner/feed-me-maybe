<script lang="ts">
  import { onMount } from 'svelte';
  import ArticleList from '#lib/components/ArticleList.svelte';
  import { getCachedArticles } from '#lib/offline/index.ts';

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
    data: {
      articles: Article[];
      totalPages: number;
      totalArticles: number;
      category: string;
      snapshotAt: number;
    };
  } = $props();
  let articles = $state<Article[]>([]);
  let liveUnreadArticleIds = $state<string[]>([]);
  let unreadCount = $derived(data.totalArticles + liveUnreadArticleIds.length);
  let unreadSnapshotAt = $state(0);
  const loadMoreSearchParams = $derived.by(() => {
    const params: Record<string, string> = {
      unread: '1',
      snapshotAt: String(data.snapshotAt),
    };
    if (data.category) params.category = data.category;
    return params;
  });

  // Count refreshes can replace page data while reusing the loaded articles.
  const loadedArticles = $derived(data.articles);

  $effect(() => {
    if (data.snapshotAt !== unreadSnapshotAt) {
      unreadSnapshotAt = data.snapshotAt;
      liveUnreadArticleIds = [];
    }
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
      <h1 class="section-title">
        {data.category ? `${data.category} inbox` : 'Inbox'}
      </h1>
      <p class="section-subtitle">
        {unreadCount} unread {unreadCount === 1 ? 'story' : 'stories'}.
      </p>
    </div>
    <a href="/search?q=is%3Aunread" class="btn preset-tonal no-underline"
      >Search unread</a
    >
  </div>

  {#key data.category}
    <ArticleList
      bind:articles
      totalPages={data.totalPages}
      liveUpdates
      onLiveArticlesAdded={addLiveUnreadArticles}
      onLiveArticleVisibilityChanged={updateLiveUnreadVisibility}
      {loadMoreSearchParams}
      emptyTitle="No unread stories"
      emptyMessage="You are all caught up."
      emptyCtaHref="/"
      emptyCtaLabel="Browse all stories"
    />
  {/key}
</div>
