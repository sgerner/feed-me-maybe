<script lang="ts">
  import { addToast } from '$lib/stores/toast.svelte';
  import { fly, fade } from 'svelte/transition';
  type SavedArticle = {
    id: string;
    title: string;
    feed_title?: string | null;
    url: string;
  };

  let { data: pageData } = $props<{ data: { articles: SavedArticle[] } }>();
  let articles = $state<SavedArticle[]>([]);
  let pendingArticleIds = $state<Record<string, boolean>>({});

  $effect(() => {
    articles = pageData.articles;
  });

  async function unsave(articleId: string) {
    if (pendingArticleIds[articleId]) return;

    const articleIndex = articles.findIndex((article: SavedArticle) => article.id === articleId);
    const previousArticle = articleIndex >= 0 ? articles[articleIndex] : null;

    if (!previousArticle) return;

    articles = articles.filter((article: SavedArticle) => article.id !== articleId);
    pendingArticleIds = { ...pendingArticleIds, [articleId]: true };

    try {
      const res = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleId, type: 'unsave' }),
      });

      if (!res.ok) {
        throw new Error('Request failed');
      }

      addToast('Removed from Saved', 'success');
    } catch (err) {
      const next = [...articles];
      next.splice(Math.min(articleIndex, next.length), 0, previousArticle);
      articles = next;
      console.error('Failed to unsave article', err);
      addToast('Action failed', 'error');
    } finally {
      const { [articleId]: _pending, ...rest } = pendingArticleIds;
      pendingArticleIds = rest;
    }
  }
</script>

<div class="mx-auto max-w-7xl">
  <div class="mb-8">
    <h1 class="section-title">Saved</h1>
    <p class="section-subtitle">{articles.length} saved articles</p>
  </div>
  {#if articles.length === 0}
    <div class="glass-card mt-16 p-8 text-center" in:fade={{ duration: 300 }}>
      <div
        class="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full"
        style="background: color-mix(in oklch, var(--color-secondary-500) 10%, transparent);"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          style="color: var(--color-secondary-400);"
        >
          <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
        </svg>
      </div>
      <p class="text-surface-300 mb-1 text-lg font-medium">
        No saved articles yet
      </p>
      <p class="section-subtitle">
        Save articles from All Feeds to read later.
      </p>
    </div>
  {:else}
    <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {#each articles as article, i (article.id)}
        <div
          class="glass-card glass-card-hover flex items-start justify-between p-4 md:p-5"
          in:fly={{ y: 14, duration: 320, delay: Math.min(i * 35, 350) }}
        >
          <div class="min-w-0 flex-1">
            <span
              class="mb-1 inline-flex items-center px-2 py-0.5 text-xs font-medium"
              style="background: color-mix(in oklch, var(--color-primary-500) 10%, transparent); color: var(--color-primary-300); border-radius: 2px;"
              >{article.feed_title}</span
            >
            <a
              href="/articles/{article.id}"
              class="block font-semibold no-underline transition-colors hover:text-primary-400"
              style="color: var(--color-surface-50);">{article.title}</a
            >
          </div>
          <button
            class="action-btn ml-3 flex-shrink-0"
            disabled={Boolean(pendingArticleIds[article.id])}
            onclick={() => unsave(article.id)}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              ><path
                d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"
              /></svg
            >
            Unsave
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>
