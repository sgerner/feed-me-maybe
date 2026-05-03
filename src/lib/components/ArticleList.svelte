<script lang="ts">
  import { addToast } from '$lib/stores/toast.svelte';
  import { onMount } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { goto } from '$app/navigation';

  let { articles = $bindable(), totalPages, feedId = null } = $props<{
    articles: any[];
    totalPages: number;
    feedId?: string | null;
  }>();

  let page = $state(1);
  let loadingMore = $state(false);
  let hasMore = $state(totalPages > 1);

  let articleIds = $derived(articles.map((a) => a.id));
  let focusedIndex = $state(0);

  function timeAgo(date: number | null): string {
    if (!date) return '';
    const seconds = Math.floor((Date.now() - date) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(date).toLocaleDateString();
  }

  async function interact(articleId: string, type: string) {
    try {
      const res = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleId, type }),
      });
      if (res.ok) {
        const labels: Record<string, string> = {
          hide: 'Hidden',
          save: 'Saved',
          thumbs_up: 'Liked',
          thumbs_down: 'Disliked',
        };
        addToast(labels[type] || type, 'success');
        if (type === 'hide') {
          articles = articles.filter((a) => a.id !== articleId);
        }
      }
    } catch {
      addToast('Action failed', 'error');
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      focusedIndex = Math.min(focusedIndex + 1, articleIds.length - 1);
      document
        .getElementById(`article-${articleIds[focusedIndex]}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      focusedIndex = Math.max(focusedIndex - 1, 0);
      document
        .getElementById(`article-${articleIds[focusedIndex]}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      if (articleIds[focusedIndex])
        goto(`/articles/${articleIds[focusedIndex]}`);
    }
    if (e.key === 'h') {
      e.preventDefault();
      if (articleIds[focusedIndex]) interact(articleIds[focusedIndex], 'hide');
    }
    if (e.key === 's') {
      e.preventDefault();
      if (articleIds[focusedIndex]) interact(articleIds[focusedIndex], 'save');
    }
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    try {
      const url = new URL('/api/articles', window.location.origin);
      url.searchParams.set('page', (page + 1).toString());
      if (feedId) url.searchParams.set('feedId', feedId);
      
      const res = await fetch(url.toString());
      if (res.ok) {
        const data = await res.json();
        if (data.articles.length === 0) {
          hasMore = false;
        } else {
          articles = [...articles, ...data.articles];
          page += 1;
          if (data.articles.length < 25) hasMore = false;
        }
      } else {
        hasMore = false;
      }
    } catch (err) {
      console.error(err);
    } finally {
      loadingMore = false;
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown);

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore) {
          loadMore();
        }
      },
      { rootMargin: '400px' },
    );

    const sentinel = document.getElementById('infinite-sentinel');
    if (sentinel) observer.observe(sentinel);

    return () => {
      document.removeEventListener('keydown', handleKeydown);
      observer.disconnect();
    };
  });

  let touchStartX = 0;
  let touchStartY = 0;

  export function handleTouchStart(e: TouchEvent) {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
  }

  export function handleTouchEnd(e: TouchEvent, articleId: string) {
    const dx = e.changedTouches[0].screenX - touchStartX;
    const dy = e.changedTouches[0].screenY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 80) {
      if (dx < 0) interact(articleId, 'hide');
      else interact(articleId, 'save');
    }
  }
</script>

{#if articles.length === 0 && !loadingMore}
  <div class="glass-card mt-16 p-8 text-center" in:fade={{ duration: 300 }}>
    <div
      class="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full"
      style="background: color-mix(in oklch, var(--color-primary-500) 10%, transparent);"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        class="text-primary-400"
      >
        <path d="M4 11a9 9 0 0 1 9 9" /><path
          d="M4 4a16 16 0 0 1 16 16"
        /><circle cx="5" cy="19" r="1" />
      </svg>
    </div>
    <p class="text-surface-300 mb-2 text-lg font-medium">No articles yet</p>
    <p class="section-subtitle mb-6">Add some RSS feeds to get started.</p>
    <a
      href="/feeds"
      class="btn preset-filled-primary-500 inline-flex items-center gap-2"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        ><line x1="12" y1="5" x2="12" y2="19" /><line
          x1="5"
          y1="12"
          x2="19"
          y2="12"
        /></svg
      >
      Add Feeds
    </a>
  </div>
{:else}
  <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
    {#each articles as article, i (article.id)}
      <div
        id="article-{article.id}"
        class="glass-card glass-card-hover group relative flex cursor-pointer flex-col overflow-hidden p-0"
        class:article-focus-ring={focusedIndex === i}
        role="link"
        tabindex="0"
        in:fly={{ y: 16, duration: 350, delay: Math.min(i * 35, 400) }}
        ontouchstart={handleTouchStart}
        ontouchend={(e) => handleTouchEnd(e, article.id)}
        onclick={(e) => {
          if (
            !(
              e.target instanceof HTMLButtonElement ||
              (e.target as HTMLElement).closest('button')
            )
          ) {
            goto(`/articles/${article.id}`);
          }
        }}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            goto(`/articles/${article.id}`);
          }
        }}
      >
        {#if article.image_url}
          <div class="relative h-48 w-full overflow-hidden">
            <img
              src={article.image_url}
              alt=""
              class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
              loading="lazy"
            />
            <div
              class="absolute inset-0 bg-gradient-to-t from-surface-950/80 to-transparent"
            ></div>
            <div class="absolute bottom-3 left-4 right-4">
              <span
                class="inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white"
                style="background: var(--color-primary-500); border-radius: 2px;"
              >
                {article.feed_title || 'Unknown'}
              </span>
            </div>
          </div>
        {/if}

        <div class="flex flex-1 flex-col p-5">
          {#if !article.image_url}
            <div
              class="mb-3 flex flex-wrap items-center gap-2 text-xs"
              style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);"
            >
              <span
                class="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium"
                style="background: color-mix(in oklch, var(--color-primary-500) 10%, transparent); color: var(--color-primary-300); border-radius: 2px;"
              >
                {article.feed_title || 'Unknown'}
              </span>
              <span class="flex items-center gap-1">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  ><circle cx="12" cy="12" r="10" /><polyline
                    points="12 6 12 12 16 14"
                  /></svg
                >
                {timeAgo(article.published_at || article.fetched_at)}
              </span>
            </div>
          {/if}

          <h3
            class="text-lg font-bold leading-tight transition-colors group-hover:text-primary-400"
            style="color: var(--color-surface-50);"
          >
            {article.title}
          </h3>

          {#if article.image_url}
            <div
              class="mt-1 flex items-center gap-1 text-[10px]"
              style="color: color-mix(in oklch, var(--color-surface-200) 40%, transparent);"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                ><circle cx="12" cy="12" r="10" /><polyline
                  points="12 6 12 12 16 14"
                /></svg
              >
              {timeAgo(article.published_at || article.fetched_at)}
            </div>
          {/if}

          {#if article.summary}
            <p
              class="mt-3 line-clamp-3 text-sm leading-relaxed"
              style="color: color-mix(in oklch, var(--color-surface-200) 65%, transparent);"
            >
              {article.summary}
            </p>
          {/if}

          <div class="mt-auto pt-5">
            <div class="flex items-center gap-1.5">
              <button
                type="button"
                class="action-btn"
                onclick={(e) => {
                  e.stopPropagation();
                  interact(article.id, 'hide');
                }}
                title="Hide (h)"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  ><path d="M3 6h18" /><path
                    d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"
                  /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg
                >
                Hide
              </button>
              <button
                type="button"
                class="action-btn"
                onclick={(e) => {
                  e.stopPropagation();
                  interact(article.id, 'save');
                }}
                title="Save (s)"
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
                Save
              </button>
              <div class="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  class="action-btn"
                  onclick={(e) => {
                    e.stopPropagation();
                    interact(article.id, 'thumbs_up');
                  }}
                  title="Like"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    ><path d="M7 10v12" /><path
                      d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"
                    /></svg
                  >
                </button>
                <button
                  type="button"
                  class="action-btn"
                  onclick={(e) => {
                    e.stopPropagation();
                    interact(article.id, 'thumbs_down');
                  }}
                  title="Dislike"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    ><path d="M17 14V2" /><path
                      d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z"
                    /></svg
                  >
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    {/each}
  </div>

  <!-- Infinite Scroll Sentinel -->
  <div id="infinite-sentinel" class="flex h-32 items-center justify-center">
    {#if loadingMore}
      <div
        class="flex items-center gap-3 text-sm"
        style="color: var(--color-surface-300);"
      >
        <div
          class="h-4 w-4 animate-spin rounded-full border-2 border-primary-500 border-t-transparent"
        ></div>
        Loading more...
      </div>
    {:else if !hasMore && articles.length > 0}
      <p class="text-sm" style="color: var(--color-surface-400);">
        No more articles to show.
      </p>
    {/if}
  </div>
{/if}