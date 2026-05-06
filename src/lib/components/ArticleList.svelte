<script lang="ts">
  import { addToast } from '$lib/stores/toast.svelte';
  import { formatContent } from '$lib/utils/format';
  import { onMount } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { goto } from '$app/navigation';
  import { page as pageStore } from '$app/stores';

  type InteractionType = 'open' | 'hide' | 'save' | 'thumbs_up' | 'thumbs_down';
  type ReactionType = 'thumbs_up' | 'thumbs_down';

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
    thumbs_up?: boolean | null;
    thumbs_down?: boolean | null;
  };

  let {
    articles = $bindable(),
    totalPages,
    feedId = null,
    showInfiniteScroll = true,
    emptyTitle = 'No articles yet',
    emptyMessage = 'Import some RSS feeds to get started.',
    emptyCtaHref = '/settings',
    emptyCtaLabel = 'Go to Settings',
  } = $props<{
    articles: Article[];
    totalPages: number;
    feedId?: string | null;
    showInfiniteScroll?: boolean;
    emptyTitle?: string;
    emptyMessage?: string;
    emptyCtaHref?: string | null;
    emptyCtaLabel?: string;
  }>();

  async function openArticle(article: Article) {
    // Determine mode: feed override or global default
    const globalMode = $pageStore.data.globalSettings?.articleOpenMode || 'app';
    const mode = article.feed_open_mode || globalMode;
    const shouldMarkOpened = mode === 'tab';
    const articleIndex = shouldMarkOpened
      ? articles.findIndex((a: Article) => a.id === article.id)
      : -1;
    const previousArticle =
      shouldMarkOpened && articleIndex >= 0 ? articles[articleIndex] : null;

    if (shouldMarkOpened && previousArticle) {
      articles = articles.filter((a: Article) => a.id !== article.id);
    }

    void fetch('/api/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId: article.id, type: 'open' }),
      keepalive: true,
    }).catch((err) => {
      console.error('Failed to record open interaction', err);

      if (
        shouldMarkOpened &&
        previousArticle &&
        !articles.some((a: Article) => a.id === article.id)
      ) {
        const next = [...articles];
        next.splice(Math.min(articleIndex, next.length), 0, previousArticle);
        articles = next;
      }
    });

    if (mode === 'tab') {
      window.open(article.url, '_blank', 'noopener,noreferrer');
    } else {
      goto(`/articles/${article.id}?mode=${mode}`);
    }
  }

  let page = $state(1);
  let loadingMore = $state(false);
  let hasMore = $state(false);
  let disableEntryTransitions = $state(false);
  let pendingArticleIds = $state<Record<string, boolean>>({});
  let sentinelEl = $state<HTMLDivElement | null>(null);
  let scrollContainerEl: HTMLElement | null = null;

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

  async function interact(articleId: string, type: InteractionType) {
    if (pendingArticleIds[articleId]) return;

    const articleIndex = articles.findIndex((a: Article) => a.id === articleId);
    const previousArticle = articleIndex >= 0 ? articles[articleIndex] : null;
    const shouldRemove = type === 'hide';
    const isReaction = type === 'thumbs_up' || type === 'thumbs_down';
    const previousReaction = previousArticle
      ? {
          thumbs_up: previousArticle.thumbs_up,
          thumbs_down: previousArticle.thumbs_down,
        }
      : null;

    if (shouldRemove && previousArticle) {
      articles = articles.filter((a: Article) => a.id !== articleId);
    }

    if (isReaction && previousArticle) {
      const reactionType = type as ReactionType;
      articles = articles.map((a: Article) =>
        a.id === articleId
          ? {
              ...a,
              thumbs_up: reactionType === 'thumbs_up',
              thumbs_down: reactionType === 'thumbs_down',
            }
          : a,
      );
    }

    pendingArticleIds = { ...pendingArticleIds, [articleId]: true };

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
      } else {
        throw new Error('Request failed');
      }
    } catch (err) {
      if (
        shouldRemove &&
        previousArticle &&
        !articles.some((a: Article) => a.id === articleId)
      ) {
        const next = [...articles];
        next.splice(Math.min(articleIndex, next.length), 0, previousArticle);
        articles = next;
      }

      if (isReaction && previousArticle && previousReaction) {
        articles = articles.map((a: Article) =>
          a.id === articleId
            ? {
                ...a,
                thumbs_up: previousReaction.thumbs_up,
                thumbs_down: previousReaction.thumbs_down,
              }
            : a,
        );
      }

      console.error('Action failed', err);
      addToast('Action failed', 'error');
    } finally {
      const { [articleId]: _pending, ...rest } = pendingArticleIds;
      pendingArticleIds = rest;
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
        console.error('Failed to load more articles', res.status);
      }
    } catch (err) {
      console.error(err);
    } finally {
      loadingMore = false;
      if (hasMore && isNearBottom()) {
        window.requestAnimationFrame(() => maybeLoadMore());
      }
    }
  }

  function isNearBottom(): boolean {
    if (!scrollContainerEl) return false;
    return (
      scrollContainerEl.scrollTop + scrollContainerEl.clientHeight >=
      scrollContainerEl.scrollHeight - 600
    );
  }

  function maybeLoadMore() {
    if (hasMore && !loadingMore && isNearBottom()) {
      void loadMore();
    }
  }

  onMount(() => {
    const mobileOrReducedMotion =
      window.matchMedia('(pointer: coarse)').matches ||
      window.matchMedia('(max-width: 1024px)').matches ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    disableEntryTransitions = mobileOrReducedMotion;

    document.addEventListener('keydown', handleKeydown);
    scrollContainerEl = document.querySelector('main');

    let scrollRaf = 0;
    const onScroll = () => {
      if (scrollRaf) return;
      scrollRaf = window.requestAnimationFrame(() => {
        scrollRaf = 0;
        maybeLoadMore();
      });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          maybeLoadMore();
        }
      },
      { root: scrollContainerEl, rootMargin: '400px' },
    );

    if (scrollContainerEl) {
      scrollContainerEl.addEventListener('scroll', onScroll, { passive: true });
    }

    if (sentinelEl) observer.observe(sentinelEl);

    maybeLoadMore();

    return () => {
      document.removeEventListener('keydown', handleKeydown);
      if (scrollContainerEl) {
        scrollContainerEl.removeEventListener('scroll', onScroll);
      }
      if (scrollRaf) window.cancelAnimationFrame(scrollRaf);
      observer.disconnect();
    };
  });

  let touchStartX = 0;
  let touchStartY = 0;
  let lastSwipeTime = 0;
  let activeSwipeId = $state<string | null>(null);
  let swipeOffsets = $state<Record<string, number>>({});
  let swipeDirection = $state<'none' | 'undecided' | 'horizontal' | 'vertical'>(
    'none',
  );

  const SWIPE_INTENT_THRESHOLD = 10;
  const SWIPE_DIRECTION_RATIO = 1.2;

  function handlePointerDown(e: PointerEvent, articleId: string) {
    if (!e.isPrimary) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    touchStartX = e.clientX;
    touchStartY = e.clientY;
    activeSwipeId = articleId;
    swipeDirection = 'undecided';
    swipeOffsets[articleId] = 0;
  }

  function handlePointerMove(e: PointerEvent, articleId: string) {
    if (!e.isPrimary || activeSwipeId !== articleId) return;
    const dx = e.clientX - touchStartX;
    const dy = e.clientY - touchStartY;

    if (swipeDirection === 'undecided') {
      if (
        Math.abs(dx) < SWIPE_INTENT_THRESHOLD &&
        Math.abs(dy) < SWIPE_INTENT_THRESHOLD
      ) {
        return;
      }

      if (Math.abs(dx) > Math.abs(dy) * SWIPE_DIRECTION_RATIO) {
        swipeDirection = 'horizontal';
      } else {
        swipeDirection = 'vertical';
        if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        }
        return;
      }
    }

    if (swipeDirection !== 'horizontal') return;

    const nextOffset = Math.max(-180, Math.min(180, dx * 0.8));
    if (Math.abs((swipeOffsets[articleId] || 0) - nextOffset) > 0.5) {
      e.preventDefault();
      swipeOffsets[articleId] = nextOffset;
    }
  }

  function handlePointerUp(e: PointerEvent, articleId: string) {
    if (!e.isPrimary || activeSwipeId !== articleId) return;
    if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    }

    const dx = e.clientX - touchStartX;
    const dy = e.clientY - touchStartY;
    touchStartX = 0;
    touchStartY = 0;
    activeSwipeId = null;

    if (swipeDirection === 'horizontal' && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 60) {
      lastSwipeTime = Date.now();
      if (dx < 0) interact(articleId, 'hide');
      else interact(articleId, 'save');
    }

    swipeDirection = 'none';
    // Snap back
    swipeOffsets[articleId] = 0;
  }

  function handlePointerCancel(_e: PointerEvent, articleId: string) {
    if (activeSwipeId === articleId) {
      activeSwipeId = null;
      swipeDirection = 'none';
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
    <p class="text-surface-300 mb-2 text-lg font-medium">{emptyTitle}</p>
    <p class="section-subtitle mb-6">{emptyMessage}</p>
    {#if emptyCtaHref}
      <a
        href={emptyCtaHref}
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
        {emptyCtaLabel}
      </a>
    {/if}
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
          class="glass-card glass-card-hover article-card group relative flex cursor-pointer flex-col overflow-hidden p-0 min-h-[180px] md:min-h-[280px]"
          style="touch-action: pan-y; transform: translateX({swipeOffsets[
            article.id
          ] || 0}px); transition: {activeSwipeId === article.id
            ? 'none'
            : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)'};"
          class:article-focus-ring={focusedIndex === i}
          role="link"
          tabindex="0"
          in:fly={disableEntryTransitions
            ? { y: 0, duration: 0, delay: 0 }
            : { y: 16, duration: 350, delay: Math.min(i * 35, 400) }}
          onpointerdown={(e) => handlePointerDown(e, article.id)}
          onpointermove={(e) => handlePointerMove(e, article.id)}
          onpointerup={(e) => handlePointerUp(e, article.id)}
          onpointercancel={(e) => handlePointerCancel(e, article.id)}
          onclick={(e) => {
            if (Date.now() - lastSwipeTime < 300) {
              e.preventDefault();
              return;
            }
            const target = e.target as Element;
            if (target && typeof target.closest === 'function' && target.closest('button, .action-btn')) {
              return;
            }
            openArticle(article);
          }}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              const target = e.target as Element;
              if (target && typeof target.closest === 'function' && target.closest('button, .action-btn')) return;
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
                class="article-card-image h-full w-full object-cover opacity-80 transition-all duration-700"
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
              class="article-card-title text-xl font-bold leading-tight transition-colors"
              style="color: var(--color-surface-50); text-shadow: 0 2px 4px rgba(0,0,0,0.3);"
            >
              {article.title}
            </h3>

            {#if article.summary}
              <div
                class="line-clamp-2 text-sm leading-relaxed prose prose-sm max-w-none"
                style="color: color-mix(in oklch, var(--color-surface-200) 65%, transparent);"
              >
                {@html formatContent(article.summary)}
              </div>
            {/if}

            <div class="mt-auto pt-2 md:pt-6">
              <div class="flex items-center gap-1.5">
                <button
                  type="button"
                  class="action-btn !hidden lg:!inline-flex !bg-surface-900/50 backdrop-blur-sm"
                  disabled={Boolean(pendingArticleIds[article.id])}
                  onpointerdown={(e) => e.stopPropagation()}
                  onpointerup={(e) => e.stopPropagation()}
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
                  disabled={Boolean(pendingArticleIds[article.id])}
                  onpointerdown={(e) => e.stopPropagation()}
                  onpointerup={(e) => e.stopPropagation()}
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
                  class="action-btn !bg-surface-900/50 backdrop-blur-sm {article.thumbs_up
                    ? '!text-primary-400 !bg-primary-500/10 !border-primary-500/30'
                    : ''}"
                  onpointerdown={(e) => e.stopPropagation()}
                  onpointerup={(e) => e.stopPropagation()}
                  onclick={(e) => {
                    e.stopPropagation();
                    interact(article.id, 'thumbs_up');
                  }}
                  aria-pressed={Boolean(article.thumbs_up)}
                  title="Like"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill={article.thumbs_up ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    stroke-width="2"
                    ><path d="M7 10v12" /><path
                      d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"
                      /></svg
                    >
                  </button>
                <button
                  type="button"
                  class="action-btn !bg-surface-900/50 backdrop-blur-sm {article.thumbs_down
                    ? '!text-error-400 !bg-error-500/10 !border-error-500/30'
                    : ''}"
                  onpointerdown={(e) => e.stopPropagation()}
                  onpointerup={(e) => e.stopPropagation()}
                  onclick={(e) => {
                    e.stopPropagation();
                    interact(article.id, 'thumbs_down');
                  }}
                  aria-pressed={Boolean(article.thumbs_down)}
                  title="Dislike"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill={article.thumbs_down ? 'currentColor' : 'none'}
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
      {#if showInfiniteScroll}
    <div bind:this={sentinelEl} class="flex h-32 items-center justify-center">
      {#if loadingMore}
        <div class="flex flex-col items-center gap-3 text-sm" style="color: var(--color-surface-300);">
          <div class="flex items-center gap-2">
            <div class="h-2.5 w-2.5 animate-bounce rounded-full bg-primary-400 [animation-delay:-0.2s]"></div>
            <div class="h-2.5 w-2.5 animate-bounce rounded-full bg-primary-400 [animation-delay:-0.1s]"></div>
            <div class="h-2.5 w-2.5 animate-bounce rounded-full bg-primary-400"></div>
          </div>
          <div class="flex items-center gap-3">
            <div
              class="h-4 w-4 animate-spin rounded-full border-2 border-primary-500 border-t-transparent"
            ></div>
            <span class="font-medium">Loading more articles...</span>
          </div>
        </div>
      {:else if !hasMore && articles.length > 0}
        <p class="text-sm" style="color: var(--color-surface-400);">
          No more articles to show.
        </p>
      {/if}
    </div>
  {/if}
{/if}
