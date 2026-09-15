<script lang="ts">
  import { addToast } from '$lib/stores/toast.svelte';
  import { formatContent } from '$lib/utils/format';
  import { onMount, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { afterNavigate, goto, invalidateAll } from '$app/navigation';
  import { page as pageStore } from '$app/stores';
  import { fetchWithCsrf } from '$lib/client/csrf';
  import {
    cacheArticles,
    enqueueOfflineMutation,
    getCachedArticles,
    type OfflineMutationType,
  } from '$lib/offline';

  type InteractionType =
    'open' | 'read' | 'hide' | 'save' | 'thumbs_up' | 'thumbs_down' | 'boost';
  type ReactionType = 'thumbs_up' | 'thumbs_down' | 'boost';

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
    read?: boolean | null;
    feed_site_url?: string | null;
    saved?: boolean | null;
    hidden?: boolean | null;
    thumbs_up?: boolean | null;
    thumbs_down?: boolean | null;
  };

  let {
    articles = $bindable(),
    totalPages,
    feedId = null,
    loadMoreSearchParams = {},
    showInfiniteScroll = true,
    feedbackMode = 'standard',
    emptyTitle = 'No articles yet',
    emptyMessage = 'Import some RSS feeds to get started.',
    emptyCtaHref = '/settings',
    emptyCtaLabel = 'Go to Settings',
  } = $props<{
    articles: Article[];
    totalPages: number;
    feedId?: string | null;
    loadMoreSearchParams?: Record<string, string>;
    showInfiniteScroll?: boolean;
    feedbackMode?: 'standard' | 'boost';
    emptyTitle?: string;
    emptyMessage?: string;
    emptyCtaHref?: string | null;
    emptyCtaLabel?: string;
  }>();

  const RETURNING_FROM_ARTICLE_KEY = 'feed-me-maybe:returning-from-article';
  const INTERACTION_LABELS: Partial<Record<InteractionType, string>> = {
    hide: 'Hidden',
    save: 'Saved',
    thumbs_up: 'Liked',
    thumbs_down: 'Disliked and hidden',
    boost: 'Boosted and restored',
    read: 'Marked as read',
  };

  function getOfflineMutationType(
    type: InteractionType,
  ): OfflineMutationType | null {
    switch (type) {
      case 'read':
      case 'hide':
      case 'save':
      case 'thumbs_down':
        return type;
      default:
        return null;
    }
  }

  function offlineScope(): string {
    return String($pageStore.data.userId || 'admin');
  }

  const summaryCache = new WeakMap<
    Article,
    { source: string; formatted: string }
  >();
  const timeAgoCache = new Map<number, { bucket: string; label: string }>();

  function getFormattedSummary(article: Article): string {
    const source = article.summary;
    if (!source) return '';

    const cached = summaryCache.get(article);
    if (cached?.source === source) return cached.formatted;

    const formatted = formatContent(source);
    summaryCache.set(article, { source, formatted });
    return formatted;
  }

  let returnRefreshPromise: Promise<void> | null = null;

  function markNeedsRefreshOnReturn(): void {
    try {
      sessionStorage.setItem(RETURNING_FROM_ARTICLE_KEY, 'true');
    } catch {
      // Session storage may be unavailable in some privacy modes.
    }
  }

  async function refreshIfReturningFromArticle(): Promise<void> {
    if (returnRefreshPromise) return returnRefreshPromise;

    let needsRefresh = false;
    try {
      needsRefresh =
        sessionStorage.getItem(RETURNING_FROM_ARTICLE_KEY) === 'true';
    } catch {
      return;
    }

    if (!needsRefresh) return;

    returnRefreshPromise = (async () => {
      try {
        await invalidateAll();
        sessionStorage.removeItem(RETURNING_FROM_ARTICLE_KEY);
      } catch (error) {
        // Leave the marker in place so a later navigation can retry.
        console.error('Failed to refresh articles after returning', error);
      }
    })();

    try {
      await returnRefreshPromise;
    } finally {
      returnRefreshPromise = null;
    }
  }

  async function openArticle(article: Article) {
    // Determine mode: feed override or global default
    const globalMode = $pageStore.data.globalSettings?.articleOpenMode || 'app';
    const hideOnOpen = Boolean($pageStore.data.globalSettings?.hideOnOpen);
    const mode = article.feed_open_mode || globalMode;
    const shouldMarkOpened = mode === 'tab' || hideOnOpen;
    const articleIndex = shouldMarkOpened
      ? articles.findIndex((a: Article) => a.id === article.id)
      : -1;
    const previousArticle =
      shouldMarkOpened && articleIndex >= 0 ? articles[articleIndex] : null;

    writeScrollRestoreState();

    if (shouldMarkOpened && previousArticle) {
      articles = articles.filter((a: Article) => a.id !== article.id);
    }

    if (openingTimeout) clearTimeout(openingTimeout);
    openingArticle = {
      id: article.id,
      label: mode === 'tab' ? 'Opening in new tab...' : 'Loading article...',
    };

    void (
      navigator.onLine === false
        ? enqueueOfflineMutation(offlineScope(), {
            articleId: article.id,
            type: 'read',
          })
        : fetchWithCsrf('/api/interactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ articleId: article.id, type: 'open' }),
            keepalive: true,
          })
    ).catch((err) => {
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
      openingTimeout = setTimeout(() => {
        if (openingArticle?.id === article.id) {
          openingArticle = null;
        }
      }, 1200);
    } else {
      markNeedsRefreshOnReturn();
      // The app shell keeps the <main> element mounted between routes, so
      // SvelteKit's document-level scroll handling does not reset this
      // container for us. Reset it before the reader route renders.
      if (scrollContainerEl) {
        scrollContainerEl.scrollTop = 0;
        scrollContainerEl.scrollLeft = 0;
      }
      await tick();
      goto(`/articles/${article.id}?mode=${mode}`);
    }
  }

  let page = $state(1);
  let loadingMore = $state(false);
  let hasMore = $state(false);
  let pendingArticleIds = $state<Record<string, boolean>>({});
  let sentinelEl = $state<HTMLDivElement | null>(null);
  let scrollContainerEl: HTMLElement | null = null;
  let openingArticle = $state<{ id: string; label: string } | null>(null);
  let openingTimeout: ReturnType<typeof setTimeout> | null = null;
  let isRestoringScroll = $state(false);
  let scrollWriteTimeout: ReturnType<typeof setTimeout> | null = null;

  let articleIds = $derived(articles.map((a: Article) => a.id));
  let focusedIndex = $state(0);
  let isBoostReview = $derived(feedbackMode === 'boost');

  type ScrollRestoreState = {
    scrollTop: number;
    page: number;
  };

  function getScrollRestoreKey(): string {
    return `feed-me-maybe:article-list-scroll:${$pageStore.url.pathname}${$pageStore.url.search}`;
  }

  function readScrollRestoreState(): ScrollRestoreState | null {
    try {
      const raw = sessionStorage.getItem(getScrollRestoreKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<ScrollRestoreState>;
      if (
        typeof parsed.scrollTop !== 'number' ||
        typeof parsed.page !== 'number'
      ) {
        return null;
      }
      return {
        scrollTop: Math.max(0, parsed.scrollTop),
        page: Math.max(1, Math.floor(parsed.page)),
      };
    } catch {
      return null;
    }
  }

  function writeScrollRestoreState(): void {
    if (!scrollContainerEl) return;
    try {
      const state: ScrollRestoreState = {
        scrollTop: scrollContainerEl.scrollTop,
        page,
      };
      sessionStorage.setItem(getScrollRestoreKey(), JSON.stringify(state));
    } catch {
      // Session storage may be unavailable in some privacy modes.
    }
  }

  function scheduleScrollRestoreWrite(): void {
    if (scrollWriteTimeout) return;

    scrollWriteTimeout = setTimeout(() => {
      scrollWriteTimeout = null;
      writeScrollRestoreState();
    }, 150);
  }

  function flushScrollRestoreWrite(): void {
    if (scrollWriteTimeout) {
      clearTimeout(scrollWriteTimeout);
      scrollWriteTimeout = null;
    }
    writeScrollRestoreState();
  }

  function clearScrollRestoreState(): void {
    try {
      sessionStorage.removeItem(getScrollRestoreKey());
    } catch {
      // Ignore storage failures.
    }
  }

  $effect(() => {
    hasMore = totalPages > 1;
  });

  $effect(() => {
    if (focusedIndex >= articleIds.length) {
      focusedIndex = Math.max(0, articleIds.length - 1);
    }
  });

  // Keep the most recently rendered library available for a fast, private
  // offline reopen. The cache module bounds and account-scopes the records.
  $effect(() => {
    if (typeof window === 'undefined' || !$pageStore.data.sessionId) return;
    void cacheArticles(offlineScope(), articles.slice(0, 150)).catch(
      (error) => {
        console.debug('Offline article cache unavailable', error);
      },
    );
  });

  function timeAgo(date: number | null): string {
    if (!date) return '';
    const now = Date.now();
    const cached = timeAgoCache.get(date);
    const seconds = Math.floor((now - date) / 1000);
    const bucket =
      seconds < 60
        ? 'now'
        : seconds < 3600
          ? `m${Math.floor(seconds / 60)}`
          : seconds < 86400
            ? `h${Math.floor(seconds / 3600)}`
            : seconds < 2592000
              ? `d${Math.floor(seconds / 86400)}`
              : 'date';
    if (cached?.bucket === bucket) return cached.label;

    let label: string;
    if (seconds < 60) label = 'just now';
    else if (seconds < 3600) label = `${Math.floor(seconds / 60)}m ago`;
    else if (seconds < 86400) label = `${Math.floor(seconds / 3600)}h ago`;
    else if (seconds < 2592000) label = `${Math.floor(seconds / 86400)}d ago`;
    else label = new Date(date).toLocaleDateString();

    timeAgoCache.set(date, { bucket, label });
    if (timeAgoCache.size > 512) timeAgoCache.clear();
    return label;
  }

  async function interact(articleId: string, type: InteractionType) {
    if (pendingArticleIds[articleId]) return;

    const articleIndex = articles.findIndex((a: Article) => a.id === articleId);
    const previousArticle = articleIndex >= 0 ? articles[articleIndex] : null;
    const shouldRemove =
      type === 'hide' ||
      type === 'thumbs_down' ||
      type === 'boost' ||
      (type === 'read' && $pageStore.url.pathname === '/inbox');
    const isReaction =
      type === 'thumbs_up' || type === 'thumbs_down' || type === 'boost';
    const previousRead = previousArticle?.read;
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
              hidden: reactionType === 'boost' ? false : a.hidden,
            }
          : a,
      );
    }

    if (type === 'read' && previousArticle) {
      articles = articles.map((a: Article) =>
        a.id === articleId ? { ...a, read: true } : a,
      );
    }

    pendingArticleIds = { ...pendingArticleIds, [articleId]: true };

    try {
      const offlineType = getOfflineMutationType(type);
      if (navigator.onLine === false) {
        if (!offlineType) throw new Error('This action needs a connection');
        await enqueueOfflineMutation(offlineScope(), {
          articleId,
          type: offlineType,
        });
        addToast('Action queued — will sync when you’re online', 'info');
        return;
      }

      const res = await fetchWithCsrf('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleId, type }),
      });
      if (res.ok) {
        addToast(INTERACTION_LABELS[type] || type, 'success');
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

      if (type === 'read' && previousArticle) {
        articles = articles.map((a: Article) =>
          a.id === articleId ? { ...a, read: previousRead } : a,
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
    if (e.key === 'Escape') {
      const openMenu = document.querySelector<HTMLDetailsElement>(
        '[data-article-overflow][open]',
      );
      if (openMenu) {
        e.preventDefault();
        openMenu.open = false;
        return;
      }
    }

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
    if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      if (articleIds[focusedIndex]) interact(articleIds[focusedIndex], 'read');
    }
  }

  async function shareArticle(article: Article) {
    const shareData = { title: article.title, url: article.url };
    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        await navigator.clipboard.writeText(article.url);
        addToast('Link copied', 'success');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      addToast('Could not share this article', 'error');
    }
  }

  function articleMode(article: Article): string {
    return (
      article.feed_open_mode ||
      $pageStore.data.globalSettings?.articleOpenMode ||
      'app'
    );
  }

  function articleHref(article: Article): string {
    const mode = articleMode(article);
    return mode === 'tab'
      ? article.url
      : `/articles/${article.id}?mode=${encodeURIComponent(mode)}`;
  }

  function handleArticleLinkClick(event: MouseEvent, article: Article): void {
    // Keep modified clicks and the context menu fully native so users can
    // still open an article in another tab or copy its link.
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    if (Date.now() - lastSwipeTime < 300) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    void openArticle(article);
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    try {
      const url = new URL('/api/articles', window.location.origin);
      url.searchParams.set('page', (page + 1).toString());
      if (feedId) url.searchParams.set('feedId', feedId);
      for (const [key, value] of Object.entries(loadMoreSearchParams)) {
        url.searchParams.set(key, String(value));
      }

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
      if (!isRestoringScroll && hasMore && isNearBottom()) {
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
    if (isRestoringScroll) return;
    if (hasMore && !loadingMore && isNearBottom()) {
      void loadMore();
    }
  }

  // A back/forward navigation handled by SvelteKit does not necessarily
  // recreate the document, so also cover that lifecycle explicitly.
  afterNavigate(() => {
    void refreshIfReturningFromArticle();
  });

  onMount(() => {
    document.addEventListener('keydown', handleKeydown);
    const onDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest('[data-article-overflow]')) {
        document
          .querySelectorAll<HTMLDetailsElement>('[data-article-overflow]')
          .forEach((menu) => (menu.open = false));
      }
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    scrollContainerEl = document.querySelector('main');

    if (navigator.onLine === false && articles.length === 0) {
      void getCachedArticles(offlineScope(), { limit: 150 })
        .then((cached) => {
          if (articles.length === 0 && cached.length > 0) {
            articles = cached;
            addToast('Showing your saved offline reading shelf', 'info');
          }
        })
        .catch(() => undefined);
    }

    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void refreshIfReturningFromArticle();
      }
    };

    window.addEventListener('pageshow', onPageShow);

    const onPageHide = () => {
      flushScrollRestoreWrite();
    };

    window.addEventListener('pagehide', onPageHide);

    let scrollRaf = 0;
    const onScroll = () => {
      if (isRestoringScroll) return;
      if (scrollRaf) return;
      scrollRaf = window.requestAnimationFrame(() => {
        scrollRaf = 0;
        scheduleScrollRestoreWrite();
        maybeLoadMore();
      });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (isRestoringScroll) return;
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

    const restoreScrollPosition = async () => {
      // Revalidate before restoring the list. Otherwise the stale page data
      // from browser history can overwrite the optimistic list state while
      // the old scroll snapshot is being reconstructed.
      await refreshIfReturningFromArticle();
      await tick();

      const restoreState = readScrollRestoreState();
      if (!restoreState || !scrollContainerEl) {
        maybeLoadMore();
        return;
      }

      isRestoringScroll = true;
      try {
        while (page < restoreState.page && hasMore) {
          await loadMore();
        }
        await tick();
        scrollContainerEl.scrollTop = restoreState.scrollTop;
        clearScrollRestoreState();
      } finally {
        isRestoringScroll = false;
        maybeLoadMore();
      }
    };

    void restoreScrollPosition();

    return () => {
      document.removeEventListener('keydown', handleKeydown);
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      if (scrollContainerEl) {
        scrollContainerEl.removeEventListener('scroll', onScroll);
      }
      if (scrollRaf) window.cancelAnimationFrame(scrollRaf);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', onPageHide);
      if (scrollWriteTimeout) {
        clearTimeout(scrollWriteTimeout);
        scrollWriteTimeout = null;
      }
      if (openingTimeout) {
        clearTimeout(openingTimeout);
        openingTimeout = null;
      }
      observer.disconnect();
    };
  });

  let touchStartX = 0;
  let touchStartY = 0;
  let lastSwipeTime = 0;
  let activeSwipeId = $state<string | null>(null);
  let activeSwipeOffset = $state(0);
  let swipeDirection = $state<'none' | 'undecided' | 'horizontal' | 'vertical'>(
    'none',
  );

  const SWIPE_INTENT_THRESHOLD = 10;
  const SWIPE_DIRECTION_RATIO = 1.2;
  const SWIPE_ACTION_THRESHOLD = 60;
  const SWIPE_LONG_LEFT_THRESHOLD = 140;

  function handlePointerDown(e: PointerEvent, articleId: string) {
    if (!e.isPrimary) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    touchStartX = e.clientX;
    touchStartY = e.clientY;
    activeSwipeId = articleId;
    swipeDirection = 'undecided';
    activeSwipeOffset = 0;
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
        activeSwipeId = null;
        activeSwipeOffset = 0;
        if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        }
        return;
      }
    }

    if (swipeDirection !== 'horizontal') return;

    if (isBoostReview && dx < 0) return;

    const nextOffset = Math.max(-180, Math.min(180, dx * 0.8));
    if (Math.abs(activeSwipeOffset - nextOffset) > 0.5) {
      e.preventDefault();
      activeSwipeOffset = nextOffset;
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

    let triggeredAction = false;
    if (swipeDirection === 'horizontal' && Math.abs(dx) > Math.abs(dy)) {
      if (!isBoostReview && dx < -SWIPE_LONG_LEFT_THRESHOLD) {
        triggeredAction = true;
        interact(articleId, 'thumbs_down');
      } else if (!isBoostReview && dx < -SWIPE_ACTION_THRESHOLD) {
        triggeredAction = true;
        interact(articleId, 'hide');
      } else if (dx > SWIPE_ACTION_THRESHOLD) {
        triggeredAction = true;
        interact(articleId, 'save');
      }
    }

    if (triggeredAction) {
      lastSwipeTime = Date.now();
    }

    swipeDirection = 'none';
    // Snap back
    activeSwipeOffset = 0;
  }

  function handlePointerCancel(_e: PointerEvent, articleId: string) {
    if (activeSwipeId === articleId) {
      activeSwipeId = null;
      swipeDirection = 'none';
      activeSwipeOffset = 0;
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
      {@const isPending = Boolean(pendingArticleIds[article.id])}
      {@const swipeOffset =
        activeSwipeId === article.id ? activeSwipeOffset : 0}
      {@const articleDate = article.published_at || article.fetched_at}
      {@const formattedSummary = article.summary
        ? getFormattedSummary(article)
        : ''}
      <div class="relative overflow-hidden rounded-sm">
        <!-- Swipe Action Indicators -->
        {#if swipeOffset !== 0}
          <div
            class="pointer-events-none absolute inset-0 z-0 transition-opacity duration-200"
            style="background: {swipeOffset > 0
              ? 'var(--color-success-500)'
              : !isBoostReview && swipeOffset < 0
                ? 'var(--color-error-500)'
                : 'transparent'}; opacity: {Math.min(
              Math.abs(swipeOffset) / 60,
              0.8,
            )};"
          >
            {#if swipeOffset > 0}
              <div class="flex h-full items-center justify-start px-6">
                <div class="flex items-center gap-2 text-white font-bold">
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
              </div>
            {/if}
            {#if !isBoostReview && swipeOffset < 0}
              <div class="flex h-full items-center justify-end px-6">
                <div class="flex items-center gap-2 text-white font-bold">
                  {#if swipeOffset < -SWIPE_LONG_LEFT_THRESHOLD}
                    Dislike + Hide
                  {:else}
                    Hide
                  {/if}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    ><path d="M3 6h18" /><path
                      d="M19 6v14c1 1-1 2-2 2H7c-1 0-2-1-2-2V6"
                    /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg
                  >
                </div>
              </div>
            {/if}
          </div>
        {/if}

        <div
          id="article-{article.id}"
          class="glass-card glass-card-hover article-card group relative flex min-h-[180px] flex-col overflow-visible p-0 md:min-h-[280px]"
          style="touch-action: pan-y; --swipe-offset: {swipeOffset}px;"
          class:article-swiping={activeSwipeId === article.id}
          class:article-focus-ring={focusedIndex === i}
        >
          <a
            href={articleHref(article)}
            target={articleMode(article) === 'tab' ? '_blank' : undefined}
            rel={articleMode(article) === 'tab'
              ? 'noopener noreferrer'
              : undefined}
            class="article-card-link relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-sm no-underline"
            style="touch-action: pan-y;"
            onpointerdown={(e) => handlePointerDown(e, article.id)}
            onpointermove={(e) => handlePointerMove(e, article.id)}
            onpointerup={(e) => handlePointerUp(e, article.id)}
            onpointercancel={(e) => handlePointerCancel(e, article.id)}
            onclick={(e) => handleArticleLinkClick(e, article)}
            aria-label={`Open article: ${article.title}`}
          >
            {#if article.image_url}
              <div class="absolute inset-0 z-0 bg-surface-950">
                <img
                  src={article.image_url}
                  alt=""
                  class="article-card-image h-full w-full object-cover opacity-80"
                  loading={i < 2 ? 'eager' : 'lazy'}
                  decoding="async"
                  fetchpriority={i < 2 ? 'high' : 'low'}
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
                  {timeAgo(articleDate)}
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
                  {@html formattedSummary}
                </div>
              {/if}
            </div>
          </a>

          <div
            class="relative z-20 flex flex-wrap items-center gap-1.5 p-3 pt-0 md:px-6 md:pb-6"
          >
            <div class="w-full">
              <div
                class="flex items-center gap-1.5 {isBoostReview
                  ? 'flex-wrap'
                  : ''}"
              >
                <button
                  type="button"
                  class="action-btn min-h-11 {isBoostReview
                    ? ''
                    : '!inline-flex'} !bg-surface-900/50 lg:backdrop-blur-sm {article.saved
                    ? '!text-secondary-400 !bg-secondary-500/10 !border-secondary-500/30'
                    : ''}"
                  disabled={isPending || Boolean(article.saved)}
                  onpointerdown={(e) => e.stopPropagation()}
                  onpointerup={(e) => e.stopPropagation()}
                  onclick={(e) => {
                    e.stopPropagation();
                    interact(article.id, 'save');
                  }}
                  title={article.saved ? 'Already saved' : 'Save (s)'}
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
                  {article.saved ? 'Saved' : 'Save'}
                </button>
                {#if !isBoostReview && !article.read}
                  <button
                    type="button"
                    class="action-btn min-h-11 !inline-flex !bg-surface-900/50 lg:backdrop-blur-sm"
                    disabled={isPending}
                    onpointerdown={(e) => e.stopPropagation()}
                    onpointerup={(e) => e.stopPropagation()}
                    onclick={(e) => {
                      e.stopPropagation();
                      interact(article.id, 'read');
                    }}
                    aria-label="Mark article as read"
                    title="Mark as read (m)"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"><path d="m5 12 4 4L19 6" /></svg
                    >
                    <span class="hidden sm:inline">Read</span>
                  </button>
                {:else if !isBoostReview}
                  <span
                    class="inline-flex min-h-11 items-center gap-1.5 px-2 text-xs text-surface-300"
                    aria-label="Article is read"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"><path d="m5 12 4 4L19 6" /></svg
                    >
                    Read
                  </span>
                {/if}
                {#if isBoostReview}
                  <button
                    type="button"
                    class="ml-auto inline-flex items-center gap-2 rounded-sm border px-4 py-2 text-sm font-semibold text-white transition hover:border-primary-400/60 hover:bg-primary-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/60 {article.thumbs_up
                      ? 'border-primary-500/40 bg-primary-500/20 shadow-[0_0_0_1px_rgba(59,130,246,0.2)]'
                      : 'border-primary-500/20 bg-primary-500/10'}"
                    disabled={isPending}
                    onpointerdown={(e) => e.stopPropagation()}
                    onpointerup={(e) => e.stopPropagation()}
                    onclick={(e) => {
                      e.stopPropagation();
                      interact(article.id, 'boost');
                    }}
                    aria-pressed={Boolean(article.thumbs_up)}
                    title="Restore to feeds and strongly boost relevance"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill={article.thumbs_up ? 'currentColor' : 'none'}
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <path
                        d="m12 2 2.9 6.2L21 10l-6 3.8L16.7 20 12 16.7 7.3 20 8 13.8 2 10l6.1-1.8Z"
                      />
                    </svg>
                    Keep &amp; boost
                  </button>
                {:else}
                  <details class="relative ml-auto" data-article-overflow>
                    <summary
                      class="action-btn flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center !bg-surface-900/50 lg:backdrop-blur-sm"
                      aria-label="More article actions"
                      title="More actions"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <circle cx="5" cy="12" r="1.5" />
                        <circle cx="12" cy="12" r="1.5" />
                        <circle cx="19" cy="12" r="1.5" />
                      </svg>
                    </summary>
                    <div
                      role="menu"
                      class="absolute bottom-full right-0 z-40 mb-2 flex min-w-52 flex-col gap-1 rounded-sm border p-2 shadow-2xl backdrop-blur-xl"
                      style="background: color-mix(in oklch, var(--color-surface-900) 94%, transparent); border-color: color-mix(in oklch, var(--color-surface-100) 15%, transparent);"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        class="article-menu-item"
                        aria-label="Share article"
                        onclick={(e) => {
                          (e.currentTarget as HTMLElement)
                            .closest('details')
                            ?.removeAttribute('open');
                          void shareArticle(article);
                        }}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                          ><circle cx="18" cy="5" r="3" /><circle
                            cx="6"
                            cy="12"
                            r="3"
                          /><circle cx="18" cy="19" r="3" /><path
                            d="m8.6 13.5 6.8 4"
                          /><path d="m15.4 6.5-6.8 4" /></svg
                        >
                        Share
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        class="article-menu-item"
                        aria-label="Hide article"
                        disabled={isPending}
                        onclick={() => interact(article.id, 'hide')}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          aria-hidden="true"
                          ><path d="M3 6h18" /><path
                            d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"
                          /><path
                            d="M8 6V4a2 2 0 0 1 2-2h4c1 0 2 1 2 2v2"
                          /></svg
                        >
                        Hide
                      </button>
                      <div
                        class="article-menu-reaction-divider my-1 h-px bg-surface-100/10"
                        aria-hidden="true"
                      ></div>
                      <button
                        type="button"
                        role="menuitemcheckbox"
                        class="article-menu-item article-menu-reaction {article.thumbs_up
                          ? 'text-primary-300'
                          : ''}"
                        aria-label="Like article"
                        disabled={isPending}
                        aria-checked={Boolean(article.thumbs_up)}
                        onclick={(e) => {
                          (e.currentTarget as HTMLElement)
                            .closest('details')
                            ?.removeAttribute('open');
                          interact(article.id, 'thumbs_up');
                        }}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill={article.thumbs_up ? 'currentColor' : 'none'}
                          stroke="currentColor"
                          stroke-width="2"
                          aria-hidden="true"
                        >
                          <path d="M7 10v12" />
                          <path
                            d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"
                          />
                        </svg>
                        Like
                      </button>
                      <button
                        type="button"
                        role="menuitemcheckbox"
                        class="article-menu-item article-menu-reaction {article.thumbs_down
                          ? 'text-error-300'
                          : ''}"
                        aria-label="Dislike and hide article"
                        disabled={isPending}
                        aria-checked={Boolean(article.thumbs_down)}
                        onclick={(e) => {
                          (e.currentTarget as HTMLElement)
                            .closest('details')
                            ?.removeAttribute('open');
                          interact(article.id, 'thumbs_down');
                        }}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill={article.thumbs_down ? 'currentColor' : 'none'}
                          stroke="currentColor"
                          stroke-width="2"
                          aria-hidden="true"
                        >
                          <path d="M17 14V2" />
                          <path
                            d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z"
                          />
                        </svg>
                        Dislike and hide
                      </button>
                    </div>
                  </details>
                  <div class="article-mobile-reactions ml-2 items-center gap-1">
                    <button
                      type="button"
                      class="action-btn min-h-11 min-w-11 !bg-surface-900/50 lg:min-h-8 lg:min-w-0 lg:backdrop-blur-sm {article.thumbs_up
                        ? '!text-primary-400 !bg-primary-500/10 !border-primary-500/30'
                        : ''}"
                      disabled={isPending}
                      onpointerdown={(e) => e.stopPropagation()}
                      onpointerup={(e) => e.stopPropagation()}
                      onclick={(e) => {
                        e.stopPropagation();
                        interact(article.id, 'thumbs_up');
                      }}
                      aria-pressed={Boolean(article.thumbs_up)}
                      aria-label="Like article"
                      title="Like article"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill={article.thumbs_up ? 'currentColor' : 'none'}
                        stroke="currentColor"
                        stroke-width="2"
                        aria-hidden="true"
                      >
                        <path d="M7 10v12" />
                        <path
                          d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"
                        />
                      </svg>
                    </button>
                    <button
                      type="button"
                      class="action-btn min-h-11 min-w-11 !bg-surface-900/50 lg:min-h-8 lg:min-w-0 lg:backdrop-blur-sm {article.thumbs_down
                        ? '!text-error-400 !bg-error-500/10 !border-error-500/30'
                        : ''}"
                      disabled={isPending}
                      onpointerdown={(e) => e.stopPropagation()}
                      onpointerup={(e) => e.stopPropagation()}
                      onclick={(e) => {
                        e.stopPropagation();
                        interact(article.id, 'thumbs_down');
                      }}
                      aria-pressed={Boolean(article.thumbs_down)}
                      aria-label="Dislike and hide article"
                      title="Dislike and hide article"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill={article.thumbs_down ? 'currentColor' : 'none'}
                        stroke="currentColor"
                        stroke-width="2"
                        aria-hidden="true"
                      >
                        <path d="M17 14V2" />
                        <path
                          d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z"
                        />
                      </svg>
                    </button>
                  </div>
                {/if}
              </div>
            </div>
          </div>
        </div>
      </div>
    {/each}
  </div>

  {#if openingArticle}
    <div
      class="pointer-events-none fixed inset-x-0 top-20 z-[70] flex justify-center px-4"
    >
      <div
        class="flex items-center gap-3 rounded-sm border px-4 py-3 shadow-2xl backdrop-blur-xl"
        style="background: color-mix(in oklch, var(--color-surface-900) 86%, transparent); border-color: color-mix(in oklch, var(--color-surface-100) 15%, transparent);"
        in:fade={{ duration: 160 }}
        out:fade={{ duration: 160 }}
      >
        <div
          class="h-4 w-4 animate-spin rounded-full border-2 border-primary-500 border-t-transparent"
        ></div>
        <div class="flex flex-col">
          <span class="text-sm font-semibold text-surface-50"
            >{openingArticle.label}</span
          >
          <span class="text-xs text-surface-300">Please wait a moment.</span>
        </div>
      </div>
    </div>
  {/if}

  <!-- Infinite Scroll Sentinel -->
  {#if showInfiniteScroll}
    <div bind:this={sentinelEl} class="flex h-32 items-center justify-center">
      {#if loadingMore}
        <div
          class="flex flex-col items-center gap-3 text-sm"
          style="color: var(--color-surface-300);"
        >
          <div class="flex items-center gap-2">
            <div
              class="h-2.5 w-2.5 animate-bounce rounded-full bg-primary-400 [animation-delay:-0.2s]"
            ></div>
            <div
              class="h-2.5 w-2.5 animate-bounce rounded-full bg-primary-400 [animation-delay:-0.1s]"
            ></div>
            <div
              class="h-2.5 w-2.5 animate-bounce rounded-full bg-primary-400"
            ></div>
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

<style>
  .article-card {
    transform: translate3d(var(--swipe-offset), 0, 0);
    transition:
      transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
      border-color 0.35s cubic-bezier(0.4, 0, 0.2, 1),
      box-shadow 0.35s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .article-card.article-swiping {
    transition: none;
    will-change: transform;
    user-select: none;
  }

  .article-card button {
    touch-action: manipulation;
  }

  .article-mobile-reactions {
    display: none;
  }

  .article-menu-item {
    display: flex;
    min-height: 2.75rem;
    width: 100%;
    align-items: center;
    gap: 0.75rem;
    border-radius: 0.25rem;
    padding: 0.5rem 0.75rem;
    color: var(--color-surface-100);
    text-align: left;
    font-size: 0.875rem;
  }

  .article-menu-item:hover,
  .article-menu-item:focus-visible {
    background: color-mix(in oklch, var(--color-primary-500) 14%, transparent);
    outline: none;
  }

  .article-menu-item:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  @media (max-width: 767px) {
    .article-mobile-reactions {
      display: flex;
    }

    .article-menu-reaction {
      display: none;
    }

    .article-menu-reaction-divider {
      display: none;
    }
  }

  [data-article-overflow] > summary::-webkit-details-marker {
    display: none;
  }

  @media (hover: hover) and (pointer: fine) {
    .article-card:hover:not(.article-swiping) {
      transform: translate3d(var(--swipe-offset), -2px, 0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .article-card,
    .article-card-image,
    .article-card-title,
    .article-card button {
      transition: none !important;
    }
  }
</style>
