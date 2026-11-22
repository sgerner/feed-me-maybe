<script lang="ts">
  import { getContext, onMount, tick } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { page as pageStore } from '$app/state';
  import { addToast } from '#lib/stores/toast.svelte.ts';
  import { fetchWithCsrf } from '#lib/client/csrf.ts';
  import {
    enqueueOfflineMutation,
    getCachedArticles,
    matchesOfflineVisibility,
    type OfflineArticle,
  } from '#lib/offline/index.ts';
  import {
    buildReaderArticleHref,
    READER_QUEUE_STORAGE_KEY,
    serializeReaderQueue,
    validateStreamOrigin,
  } from '#lib/reader-queue.ts';

  type RecoveryArticle = {
    id: string;
    title: string;
    url: string;
    feedTitle: string;
    read: boolean;
    saved: boolean;
    hidden: boolean;
    rejected: boolean;
    thumbsDown: boolean;
    stateChangedAt?: number | null;
    cached?: OfflineArticle;
  };

  let articles = $state<RecoveryArticle[]>([]);
  let loading = $state(true);
  let errorMessage = $state('');
  let statusAnnouncement = $state('');
  let restoring = $state<Record<string, boolean>>({});
  let heading = $state<HTMLHeadingElement>();
  let nextCursor = $state<string | null>(null);
  let offlineFallback = $state(false);
  const openCachedArticle = getContext<
    ((article: OfflineArticle) => Promise<void>) | undefined
  >('openCachedArticle');

  function offlineScope(): string {
    return String(pageStore.data.userId || 'admin');
  }

  const recoverySource = $derived(
    validateStreamOrigin(`${pageStore.url.pathname}${pageStore.url.search}`) ??
      '/recovery',
  );

  const recoveryKindFilter = $derived.by<'all' | 'hidden' | 'rejected'>(() => {
    const raw = (pageStore.url.searchParams.get('kind') || 'all').toLowerCase();
    return raw === 'hidden' || raw === 'rejected' ? raw : 'all';
  });

  const recoveryFeedId = $derived(
    pageStore.url.searchParams.get('feedId') || null,
  );

  function recoveryArticleHref(articleId: string): string {
    return buildReaderArticleHref(articleId, { from: recoverySource });
  }

  function writeRecoveryReaderQueue(): void {
    try {
      const serialized = serializeReaderQueue({
        ids: articles.map((item) => item.id),
        source: recoverySource,
        pagination:
          !offlineFallback && nextCursor
            ? {
                kind: 'recovery',
                nextCursor,
                limit: 50,
                feedId: recoveryFeedId,
                kindFilter: recoveryKindFilter,
              }
            : null,
      });
      if (serialized) {
        sessionStorage.setItem(READER_QUEUE_STORAGE_KEY, serialized);
      }
    } catch {
      // Direct reader navigation still works without session storage.
    }
  }

  async function loadCachedRecoveryFallback(): Promise<boolean> {
    try {
      const cached = await getCachedArticles(offlineScope());
      const hiddenOrRejected = cached.filter(
        (item) =>
          item.cleared_at == null &&
          (matchesOfflineVisibility(item, 'hidden') ||
            matchesOfflineVisibility(item, 'rejected')),
      );
      articles = hiddenOrRejected.map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        feedTitle: item.feed_title || 'Unknown source',
        read: Boolean(item.read),
        saved: Boolean(item.saved),
        hidden: Boolean(item.hidden),
        rejected: Boolean(item.thumbs_down),
        thumbsDown: Boolean(item.thumbs_down),
        stateChangedAt: item.updatedAt,
        cached: item,
      }));
      nextCursor = null;
      offlineFallback = true;
      errorMessage = '';
      statusAnnouncement = articles.length
        ? `Showing ${articles.length} cached hidden or rejected ${articles.length === 1 ? 'article' : 'articles'}.`
        : '';
      return true;
    } catch {
      return false;
    }
  }

  async function loadRecovery(append = false) {
    loading = !append;
    if (!append) statusAnnouncement = 'Loading hidden and rejected articles.';
    errorMessage = '';
    try {
      if (navigator.onLine === false && !append) {
        if (await loadCachedRecoveryFallback()) return;
      }
      const params = new SvelteURLSearchParams({ limit: '50' });
      if (recoveryKindFilter !== 'all') params.set('kind', recoveryKindFilter);
      if (recoveryFeedId) params.set('feedId', recoveryFeedId);
      if (append && nextCursor) params.set('cursor', nextCursor);
      const signal =
        typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
          ? AbortSignal.timeout(12_000)
          : undefined;
      const response = await fetch(
        `/api/article-state/recovery?${params}`,
        signal ? { signal } : undefined,
      );
      if (!response.ok) throw new Error('Recovery is unavailable right now.');
      const payload = (await response.json()) as {
        articles?: RecoveryArticle[];
        nextCursor?: string | null;
      };
      offlineFallback = false;
      articles = append
        ? [...articles, ...(payload.articles || [])]
        : payload.articles || [];
      nextCursor = payload.nextCursor ?? null;
      if (append) {
        writeRecoveryReaderQueue();
      }
      statusAnnouncement = articles.length
        ? `${articles.length} hidden or rejected ${articles.length === 1 ? 'article' : 'articles'} loaded.`
        : '';
    } catch (error) {
      if (!append && (await loadCachedRecoveryFallback())) {
        return;
      }
      errorMessage =
        error instanceof Error ? error.message : 'Recovery failed.';
      statusAnnouncement = '';
    } finally {
      loading = false;
    }
  }

  async function openRecoveryArticle(
    event: MouseEvent,
    article: RecoveryArticle,
  ) {
    writeRecoveryReaderQueue();
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    if ((offlineFallback || navigator.onLine === false) && openCachedArticle) {
      event.preventDefault();
      const cached =
        article.cached ??
        (await getCachedArticles(offlineScope())
          .then((list) => list.find((item) => item.id === article.id))
          .catch(() => undefined));
      await openCachedArticle(
        cached ?? {
          id: article.id,
          title: article.title,
          url: article.url,
          feed_title: article.feedTitle,
          read: article.read,
          saved: article.saved,
          hidden: article.hidden,
          thumbs_down: article.thumbsDown,
        },
      );
    }
  }

  async function removeAndRefocus(
    article: RecoveryArticle,
    trigger: HTMLButtonElement,
  ) {
    const index = articles.indexOf(article);
    const hadFocus =
      document.activeElement === trigger ||
      document.activeElement === document.body;
    articles = articles.filter((item) => item.id !== article.id);
    await tick();
    if (
      hadFocus &&
      (document.activeElement === document.body ||
        document.activeElement === trigger)
    ) {
      const neighbor = articles[Math.min(index, articles.length - 1)];
      const next = neighbor
        ? document.getElementById(`restore-${neighbor.id}`)
        : heading;
      next?.focus();
    }
  }

  async function restore(article: RecoveryArticle, trigger: HTMLButtonElement) {
    if (restoring[article.id]) return;
    restoring = { ...restoring, [article.id]: true };
    try {
      if (navigator.onLine === false || offlineFallback) {
        await enqueueOfflineMutation(offlineScope(), {
          articleId: article.id,
          type: 'restore',
        });
        await removeAndRefocus(article, trigger);
        addToast('Restore queued — will sync when you’re online', 'info');
        return;
      }

      const response = await fetchWithCsrf('/api/article-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          articleId: article.id,
          action: 'restore',
          state: { hidden: false, rejected: false },
        }),
      });
      if (!response.ok) {
        throw new Error('Could not restore this article.');
      }
      await removeAndRefocus(article, trigger);
      addToast('Article restored to your feed', 'success');
    } catch (error) {
      if (
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === 'TimeoutError')
      ) {
        try {
          await enqueueOfflineMutation(offlineScope(), {
            articleId: article.id,
            type: 'restore',
          });
          await removeAndRefocus(article, trigger);
          addToast('Restore queued — will sync when you’re online', 'info');
          return;
        } catch {
          // Fall through to error toast below.
        }
      }
      addToast(
        error instanceof Error ? error.message : 'Restore failed',
        'error',
      );
    } finally {
      const { [article.id]: _pending, ...rest } = restoring;
      restoring = rest;
    }
  }

  function relativeTime(value?: number | null): string {
    if (!value) return 'Previously';
    const days = Math.floor((Date.now() - value) / 86_400_000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return `${days} days ago`;
  }

  onMount(() => {
    void loadRecovery();
    const handleOfflineArticleUpdated = (event: Event) => {
      const updated = (event as CustomEvent<OfflineArticle | undefined>).detail;
      if (!updated?.id) return;
      if (!updated.hidden && !updated.thumbs_down) {
        articles = articles.filter((item) => item.id !== updated.id);
      }
    };
    window.addEventListener(
      'feed-me-maybe:offline-article-updated',
      handleOfflineArticleUpdated,
    );
    return () => {
      window.removeEventListener(
        'feed-me-maybe:offline-article-updated',
        handleOfflineArticleUpdated,
      );
    };
  });
</script>

<svelte:head>
  <title>Recovery · Feed Me Maybe</title>
  <meta
    name="description"
    content="Restore articles you previously hid or rejected."
  />
</svelte:head>

<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
  {statusAnnouncement}
</p>

<div class="mx-auto max-w-5xl">
  <div class="mb-8">
    <p class="eyebrow text-secondary-300">Review hidden and rejected</p>
    <h1 class="section-title" bind:this={heading} tabindex="-1">Recovery</h1>
    <p class="section-subtitle">
      Restore hidden, rejected, or disliked articles.
    </p>
  </div>

  {#if loading}
    <div
      class="glass-card flex min-h-48 items-center justify-center p-8"
      aria-busy="true"
      aria-label="Loading recovery list"
    >
      <div
        class="h-8 w-8 animate-spin rounded-full border-2 border-secondary-400 border-t-transparent"
      ></div>
    </div>
  {:else if errorMessage}
    <div class="glass-card p-8 text-center">
      <p class="text-error-300" role="alert">{errorMessage}</p>
      <button
        type="button"
        class="btn preset-tonal mt-4"
        onclick={() => void loadRecovery()}>Try again</button
      >
    </div>
  {:else if articles.length === 0}
    <div class="glass-card p-10 text-center">
      <p class="text-lg font-semibold text-surface-100" role="status">
        No hidden or rejected articles
      </p>
      <p class="section-subtitle mt-2">
        Articles you restore will appear in your feeds again.
      </p>
    </div>
  {:else}
    <div class="space-y-3">
      {#each articles as article (article.id)}
        <article
          class="glass-card flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between md:p-5"
        >
          <div class="min-w-0">
            <div
              class="mb-2 flex flex-wrap items-center gap-2 text-xs text-surface-300"
            >
              <span
                class="rounded-full bg-error-500/10 px-2 py-1 text-error-300"
                >{article.rejected || article.thumbsDown
                  ? 'Rejected'
                  : 'Hidden'}</span
              >
              <span>{article.feedTitle || 'Unknown source'}</span>
              <span>·</span>
              <span>{relativeTime(article.stateChangedAt)}</span>
            </div>
            <a
              id="recovery-title-{article.id}"
              class="block font-semibold text-surface-100 no-underline transition hover:text-primary-300"
              href={recoveryArticleHref(article.id)}
              onauxclick={(e) => {
                if (e.button === 1) writeRecoveryReaderQueue();
              }}
              onclick={(e) => void openRecoveryArticle(e, article)}
              >{article.title}</a
            >
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <a
              class="btn preset-tonal no-underline"
              href={recoveryArticleHref(article.id)}
              onauxclick={(e) => {
                if (e.button === 1) writeRecoveryReaderQueue();
              }}
              onclick={(e) => void openRecoveryArticle(e, article)}
              aria-label="Review {article.title}">Review</a
            >
            <button
              type="button"
              class="btn preset-filled-secondary-500"
              id="restore-{article.id}"
              aria-label={restoring[article.id]
                ? `Restoring ${article.title}`
                : `Restore ${article.title}`}
              onclick={(event) => void restore(article, event.currentTarget)}
              disabled={Boolean(restoring[article.id])}
              >{restoring[article.id] ? 'Restoring…' : 'Restore'}</button
            >
          </div>
        </article>
      {/each}
    </div>
    {#if nextCursor}
      <div class="flex justify-center py-8">
        <button
          type="button"
          class="btn preset-tonal"
          onclick={() => void loadRecovery(true)}>Load more</button
        >
      </div>
    {/if}
  {/if}
</div>
