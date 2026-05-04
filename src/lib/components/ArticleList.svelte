<script lang="ts">
  import { addToast } from '$lib/stores/toast.svelte';
  import { onMount } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { goto } from '$app/navigation';
  import { page as pageStore } from '$app/stores';

  type Article = {
    id: string;
    url: string;
    title: string;
    summary?: string | null;
    image_url?: string | null;
    published_at?: number | null;
    feed_title?: string | null;
    feed_open_mode?: string | null;
    feed_url?: string | null;
    feed_site_url?: string | null;
  };

  let {
    articles = $bindable(),
    totalPages,
    feedId = null,
  } = $props<{
    articles: Article[];
    totalPages: number;
    feedId?: string | null;
  }>();

  async function openArticle(article: Article) {
    // Determine mode: feed override or global default
    const globalMode = $pageStore.data.globalSettings?.articleOpenMode || 'app';
    const mode = article.feed_open_mode || globalMode;

    // Record interaction
    try {
      fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleId: article.id, type: 'open' }),
      });

      // If "hide on open" is active, remove from local list
      if ($pageStore.data.globalSettings?.hideOnOpen) {
        articles = articles.filter((a: Article) => a.id !== article.id);
      }
    } catch (err) {
      console.error('Failed to record open interaction', err);
    }

    if (mode === 'tab') {
      window.open(article.url, '_blank', 'noopener,noreferrer');
    } else {
      goto(`/articles/${article.id}?mode=${mode}`);
    }
  }

  let page = $state(1);
  let loadingMore = $state(false);
  let hasMore = $state(false);

  let articleIds = $derived(articles.map((a: Article) => a.id));
  let focusedIndex = $state(0);

  $effect(() => {
    hasMore = totalPages > 1;
  });

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
          articles = articles.filter((a: Article) => a.id !== articleId);
        }
      }
    } catch {
      addToast('Action failed', 'error');
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    ) {
      return;
    }

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
      if (articles[focusedIndex]) openArticle(articles[focusedIndex]);
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
  let lastSwipeTime = 0;
  let activeSwipeId = $state<string | null>(null);
  let swipeOffsets = $state<Record<string, number>>({});

  function handlePointerDown(e: PointerEvent, articleId: string) {
    if (!e.isPrimary) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    touchStartX = e.clientX;
    touchStartY = e.clientY;
    activeSwipeId = articleId;
    swipeOffsets[articleId] = 0;
  }

  function handlePointerMove(e: PointerEvent, articleId: string) {
    if (!e.isPrimary || activeSwipeId !== articleId) return;
    const dx = e.clientX - touchStartX;
    const dy = e.clientY - touchStartY;

    // Only track drag if horizontal movement is more prominent
    if (Math.abs(dx) > Math.abs(dy) || swipeOffsets[articleId] !== 0) {
      swipeOffsets[articleId] = dx * 0.8; // Added friction
    }
  }

  function handlePointerUp(e: PointerEvent, articleId: string) {
    if (!e.isPrimary || activeSwipeId !== articleId) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);

    const dx = e.clientX - touchStartX;
    const dy = e.clientY - touchStartY;
    touchStartX = 0;
    touchStartY = 0;
    activeSwipeId = null;

    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 60) {
      lastSwipeTime = Date.now();
      if (dx < 0) interact(articleId, 'hide');
      else interact(articleId, 'save');
    }

    // Snap back
    swipeOffsets[articleId] = 0;
  }

  function handlePointerCancel(e: PointerEvent, articleId: string) {
    if (activeSwipeId === articleId) {
      activeSwipeId = null;
      swipeOffsets[articleId] = 0;
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
    <p class="section-subtitle mb-6">Import some RSS feeds to get started.</p>
    <a
      href="/settings"
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
      Go to Settings
    </a>
  </div>
{:else}
  <div class="grid grid-cols-1 md:gap-4 xl:grid-cols-2">
    {#each articles as article, i (article.id)}
      <div class="relative overflow-hidden rounded-sm">
        <!-- Swipe Action Indicators -->
        <div
          class="absolute inset-0 flex items-center justify-between px-6 z-0 pointer-events-none transition-colors duration-200"
          style="background: {(swipeOffsets[article.id] || 0) > 0
            ? 'var(--color-success-500)'
            : (swipeOffsets[article.id] || 0) < 0
              ? 'var(--color-error-500)'
              : 'transparent'}; opacity: {Math.min(
            Math.abs(swipeOffsets[article.id] || 0) / 60,
            0.8,
          )};"
        >
          <div
            class="flex items-center gap-2 text-white font-bold"
            style="opacity: {(swipeOffsets[article.id] || 0) > 0 ? 1 : 0}"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="currentColor"
              stroke-width="2"
              ><path
                d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"
              /></svg
            >
            Save
          </div>
          <div
            class="flex items-center gap-2 text-white font-bold"
            style="opacity: {(swipeOffsets[article.id] || 0) < 0 ? 1 : 0}"
          >
            Hide
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              ><path d="M3 6h18" /><path
                d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"
              /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg
            >
          </div>
        </div>

        <div
          id="article-{article.id}"
          class="glass-card glass-card-hover group relative flex cursor-pointer flex-col overflow-hidden p-0 min-h-[180px] md:min-h-[280px]"
          style="touch-action: pan-y; transform: translateX({swipeOffsets[
            article.id
          ] || 0}px); transition: {activeSwipeId === article.id
            ? 'none'
            : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)'};"
          class:article-focus-ring={focusedIndex === i}
          role="link"
          tabindex="0"
          in:fly={{ y: 16, duration: 350, delay: Math.min(i * 35, 400) }}
          onpointerdown={(e) => handlePointerDown(e, article.id)}
          onpointermove={(e) => handlePointerMove(e, article.id)}
          onpointerup={(e) => handlePointerUp(e, article.id)}
          onpointercancel={(e) => handlePointerCancel(e, article.id)}
          onclick={(e) => {
            if (Date.now() - lastSwipeTime < 300) {
              e.preventDefault();
              return;
            }
            if ((e.target as Element).closest('button')) {
              return;
            }
            openArticle(article);
          }}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              if ((e.target as Element).closest('button')) return;
              e.preventDefault();
              openArticle(article);
            }
          }}
        >
          {#if article.image_url}
            <div class="absolute inset-0 z-0 bg-surface-950">
              <img
                src={article.image_url}
                alt=""
                class="h-full w-full object-cover opacity-80 transition-all duration-700 group-hover:scale-110 group-hover:opacity-100"
                style="filter: brightness(0.6);"
                loading="lazy"
              />
              <div
                class="absolute inset-0 bg-gradient-to-t from-surface-950 via-surface-950/40 to-transparent opacity-90"
              ></div>
            </div>
          {/if}

          <div class="relative z-10 flex flex-1 flex-col p-3 md:p-6">
            <div
              class="mb-3 flex flex-wrap items-center gap-2 text-xs"
              style="color: color-mix(in oklch, var(--color-surface-200) 70%, transparent);"
            >
              <span
                class="inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white"
                style="background: var(--color-primary-500); border-radius: 2px;"
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

            <h3
              class="text-xl font-bold leading-tight transition-colors group-hover:text-primary-400"
              style="color: var(--color-surface-50); text-shadow: 0 2px 4px rgba(0,0,0,0.3);"
            >
              {article.title}
            </h3>

            {#if article.summary}
              <p
                class="mt-3 line-clamp-2 text-sm leading-relaxed"
                style="color: color-mix(in oklch, var(--color-surface-100) 80%, transparent);"
              >
                {article.summary}
              </p>
            {/if}

            <div class="mt-auto pt-2 md:pt-6">
              <div class="flex items-center gap-1.5">
                <button
                  type="button"
                  class="action-btn !hidden lg:!inline-flex !bg-surface-900/50 backdrop-blur-sm"
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
                  class="action-btn !hidden lg:!inline-flex !bg-surface-900/50 backdrop-blur-sm"
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
                    class="action-btn !bg-surface-900/50 backdrop-blur-sm"
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
                    class="action-btn !bg-surface-900/50 backdrop-blur-sm"
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
