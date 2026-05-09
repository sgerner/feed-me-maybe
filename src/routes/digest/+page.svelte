<script lang="ts">
  import { onMount } from 'svelte';
  import { syncFeeds } from '$lib/feeds';

  type DigestArticle = {
    id: string;
    url: string;
    title: string;
    summary?: string | null;
    image_url?: string | null;
    published_at?: number | null;
    fetched_at?: number | null;
    read?: boolean;
    saved?: boolean;
    feed_title?: string | null;
    feed_url?: string | null;
  };

  type DigestStory = {
    article: DigestArticle;
    reason: string;
  };

  type DigestTheme = {
    name: string;
    summary: string;
    articles: DigestArticle[];
  };

  type WeeklyDigest = {
    headline: string;
    summary: string;
    takeaways: string[];
    themes: DigestTheme[];
    topStories: DigestStory[];
    missedStories: DigestStory[];
    activeFeeds: Array<{ title: string; count: number }>;
    totalArticles: number;
    totalFeeds: number;
    unreadArticles: number;
    savedArticles: number;
    windowStart: number;
    windowEnd: number;
    generatedAt: number;
    cacheHit: boolean;
  };

  const EMPTY_DIGEST: WeeklyDigest = {
    headline: 'Weekly Digest',
    summary: '',
    takeaways: [],
    themes: [],
    topStories: [],
    missedStories: [],
    activeFeeds: [],
    totalArticles: 0,
    totalFeeds: 0,
    unreadArticles: 0,
    savedArticles: 0,
    windowStart: Date.now(),
    windowEnd: Date.now(),
    generatedAt: Date.now(),
    cacheHit: false,
  };

  let digest = $state<WeeklyDigest>(EMPTY_DIGEST);
  let loading = $state(true);
  let hasLoaded = $state(false);
  let refreshing = $state(false);
  let errorMessage = $state('');
  let pullDistance = $state(0);
  let isPulling = $state(false);
  let touchStartY = 0;
  let requestId = 0;

  function getScrollContainer(): HTMLElement | null {
    return document.querySelector('main');
  }

  function isAtTop(): boolean {
    const container = getScrollContainer();
    return !container || container.scrollTop <= 0;
  }

  function timeAgo(date: number): string {
    const seconds = Math.floor((Date.now() - date) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(date).toLocaleDateString();
  }

  function windowLabel(value: number): string {
    return new Date(value).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  }

  function formatError(value: unknown): string {
    if (value instanceof Error) return value.message;
    if (typeof value === 'string') return value;
    return 'Unable to load the weekly digest.';
  }

  async function loadDigest(options: { sync?: boolean } = {}) {
    const currentRequest = ++requestId;
    if (!hasLoaded) {
      loading = true;
    } else {
      refreshing = true;
    }
    errorMessage = '';

    try {
      if (options.sync) {
        await syncFeeds({ silent: true });
      }

      const res = await fetch(`/api/digest?ts=${Date.now()}`, {
        headers: {
          Accept: 'application/json',
        },
      });

      if (!res.ok) {
        throw new Error(
          res.status === 401 ? 'Unauthorized' : 'Failed to load weekly digest.',
        );
      }

      const data = (await res.json()) as WeeklyDigest;
      if (currentRequest !== requestId) return;
      digest = data;
      hasLoaded = true;
    } catch (err) {
      if (currentRequest !== requestId) return;
      errorMessage = formatError(err);
    } finally {
      if (currentRequest !== requestId) return;
      loading = false;
      refreshing = false;
      hasLoaded = true;
    }
  }

  onMount(() => {
    void loadDigest();
  });

  function handleRefresh() {
    void loadDigest();
  }

  function handleTouchStart(e: TouchEvent) {
    touchStartY = e.changedTouches[0].screenY;
    isPulling = false;
    pullDistance = 0;
  }

  function handleTouchMove(e: TouchEvent) {
    if (!isAtTop()) return;

    const currentY = e.changedTouches[0].screenY;
    const diff = currentY - touchStartY;
    if (diff <= 0) {
      pullDistance = 0;
      isPulling = false;
      return;
    }

    if (diff < 12 && !isPulling) return;

    if (!isPulling) {
      isPulling = true;
    }

    e.preventDefault();
    pullDistance = Math.min(diff * 0.4, 80);
  }

  function handleTouchEnd() {
    if (isPulling && pullDistance >= 60) {
      void loadDigest({ sync: true });
    }
    pullDistance = 0;
    isPulling = false;
  }
</script>

<div
  class="mx-auto max-w-6xl"
  role="presentation"
  aria-busy={loading || refreshing}
  style="overscroll-behavior-y: contain; touch-action: pan-y;"
  ontouchstart={handleTouchStart}
  ontouchmove={handleTouchMove}
  ontouchend={handleTouchEnd}
>
  <div
    class="flex justify-center overflow-hidden transition-all duration-200"
    style="height: {pullDistance}px; opacity: {pullDistance / 60};"
  >
    <div class="mt-4 flex items-center gap-2 text-primary-400">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        class={pullDistance >= 60 ? 'rotate-180' : ''}
        style="transition: transform 0.2s;"
      >
        <path d="M12 5v14M19 12l-7 7-7-7" />
      </svg>
      <span class="text-xs font-bold uppercase tracking-wider">
        {loading && !digest
          ? 'Loading digest...'
          : refreshing
            ? 'Refreshing...'
            : pullDistance >= 60
              ? 'Release to refresh'
              : 'Pull to refresh'}
      </span>
    </div>
  </div>

  {#if loading && !hasLoaded}
    <div class="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div class="min-w-0 flex-1 animate-pulse">
        <div class="h-8 w-56 rounded-sm bg-surface-200/15"></div>
        <div class="mt-3 h-4 w-80 rounded-sm bg-surface-200/10"></div>
        <div class="mt-4 flex flex-wrap gap-2">
          <div class="h-5 w-20 rounded-sm bg-surface-200/10"></div>
          <div class="h-5 w-16 rounded-sm bg-surface-200/10"></div>
          <div class="h-5 w-16 rounded-sm bg-surface-200/10"></div>
          <div class="h-5 w-24 rounded-sm bg-surface-200/10"></div>
        </div>
      </div>
      <div class="h-10 w-10 rounded-sm bg-surface-200/10 md:w-28"></div>
    </div>

    <section class="mb-8 rounded-sm border p-5 md:p-6 animate-pulse"
      style="background: color-mix(in oklch, var(--color-primary-500) 7%, transparent); border-color: color-mix(in oklch, var(--color-primary-500) 16%, transparent);">
      <div class="mb-3 h-4 w-24 rounded-sm bg-surface-200/10"></div>
      <div class="h-5 w-full rounded-sm bg-surface-200/10"></div>
      <div class="mt-2 h-5 w-5/6 rounded-sm bg-surface-200/10"></div>
      <div class="mt-4 grid gap-2 md:grid-cols-2">
        {#each [1, 2, 3, 4] as item (item)}
          <div class="h-4 rounded-sm bg-surface-200/10"></div>
        {/each}
      </div>
    </section>

    <div class="grid gap-8 lg:grid-cols-[1.45fr_1fr]">
      <section class="space-y-3">
        {#each [1, 2, 3, 4, 5] as item (item)}
          <div class="rounded-sm border p-4 animate-pulse"
            style="border-color: color-mix(in oklch, var(--color-surface-200) 12%, transparent); background: color-mix(in oklch, var(--color-surface-900) 24%, transparent);">
            <div class="flex items-start gap-3">
              <div class="h-4 w-8 rounded-sm bg-surface-200/10"></div>
              <div class="min-w-0 flex-1 space-y-2">
                <div class="h-3 w-28 rounded-sm bg-surface-200/10"></div>
                <div class="h-5 w-5/6 rounded-sm bg-surface-200/10"></div>
                <div class="h-4 w-full rounded-sm bg-surface-200/10"></div>
                <div class="h-4 w-2/3 rounded-sm bg-surface-200/10"></div>
              </div>
            </div>
          </div>
        {/each}
      </section>

      <aside class="space-y-8">
        <section class="animate-pulse">
          <div class="mb-3 h-4 w-32 rounded-sm bg-surface-200/10"></div>
          <div class="space-y-4">
            {#each [1, 2, 3] as item (item)}
              <div class="rounded-sm border p-4"
                style="border-color: color-mix(in oklch, var(--color-surface-200) 12%, transparent); background: color-mix(in oklch, var(--color-surface-900) 24%, transparent);">
                <div class="h-4 w-28 rounded-sm bg-surface-200/10"></div>
                <div class="mt-2 h-4 w-full rounded-sm bg-surface-200/10"></div>
                <div class="mt-2 h-4 w-5/6 rounded-sm bg-surface-200/10"></div>
              </div>
            {/each}
          </div>
        </section>

        <section class="animate-pulse">
          <div class="mb-3 h-4 w-44 rounded-sm bg-surface-200/10"></div>
          <div class="space-y-2">
            {#each [1, 2, 3] as item (item)}
              <div class="h-10 rounded-sm border"
                style="border-color: color-mix(in oklch, var(--color-surface-200) 10%, transparent); background: color-mix(in oklch, var(--color-surface-900) 18%, transparent);"></div>
            {/each}
          </div>
        </section>
      </aside>
    </div>
  {:else if errorMessage}
    <div class="glass-card mt-12 p-8 text-center">
      <div
        class="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full"
        style="background: color-mix(in oklch, var(--color-error-500) 10%, transparent);"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" style="color: var(--color-error-400);">
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        </svg>
      </div>
      <p class="mb-2 text-lg font-medium text-surface-100">Digest unavailable</p>
      <p class="section-subtitle">{errorMessage}</p>
      <button
        type="button"
        class="btn preset-filled-surface-200-800 mt-6"
        onclick={handleRefresh}
      >
        Retry
      </button>
    </div>
  {:else if digest}
    <div class="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div class="min-w-0 flex-1">
        <h1 class="section-title">Weekly Digest</h1>
        <p class="section-subtitle">
          {windowLabel(digest.windowStart)} to {windowLabel(digest.windowEnd)} across
          {digest.totalFeeds} feeds.
          {#if digest.cacheHit}
            Cached digest.
          {/if}
        </p>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <span
            class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style="background: color-mix(in oklch, var(--color-primary-500) 12%, transparent); color: var(--color-primary-300); border-radius: 2px;"
          >
            {digest.totalArticles} articles
          </span>
          <span
            class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style="background: color-mix(in oklch, var(--color-secondary-500) 12%, transparent); color: var(--color-secondary-300); border-radius: 2px;"
          >
            {digest.unreadArticles} unread
          </span>
          <span
            class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style="background: color-mix(in oklch, var(--color-warning-500) 12%, transparent); color: var(--color-warning-300); border-radius: 2px;"
          >
            {digest.savedArticles} saved
          </span>
          <span
            class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style="background: color-mix(in oklch, var(--color-surface-200) 10%, transparent); color: var(--color-surface-100); border-radius: 2px;"
          >
            Updated {timeAgo(digest.generatedAt)}
          </span>
        </div>
      </div>

      <button
        type="button"
        class="btn preset-filled-surface-200-800 flex h-10 w-10 items-center justify-center p-0 md:h-auto md:w-auto md:px-4 md:py-2 md:gap-2"
        onclick={handleRefresh}
        aria-label="Refresh digest"
        title="Refresh digest"
        disabled={refreshing}
      >
        {#if refreshing}
          <div class="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"></div>
        {:else}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10" />
            <path d="M20.49 15A9 9 0 0 1 6.36 18.36L1 14" />
          </svg>
        {/if}
        <span class="hidden md:inline">{refreshing ? 'Refreshing' : 'Refresh'}</span>
      </button>
    </div>

    <section
      class="mb-8 rounded-sm border p-5 md:p-6"
      style="background: color-mix(in oklch, var(--color-primary-500) 7%, transparent); border-color: color-mix(in oklch, var(--color-primary-500) 16%, transparent);"
    >
      <div
        class="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider"
        style="color: var(--color-primary-300);"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 4h16v12H4z" />
          <path d="M8 20h8" />
          <path d="M12 16v4" />
        </svg>
        AI Briefing
      </div>
      <p class="text-base leading-relaxed text-surface-100 md:text-lg">
        {digest.summary || 'A weekly readout of the stories that moved across your feeds.'}
      </p>

      {#if digest.takeaways.length > 0}
        <div class="mt-4 grid gap-2 md:grid-cols-2">
          {#each digest.takeaways as item}
            <div class="flex gap-2 text-sm leading-relaxed text-surface-200">
              <span class="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-primary-400"></span>
              <span>{item}</span>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    {#if digest.totalArticles === 0}
      <div class="glass-card mt-12 p-8 text-center">
        <div
          class="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full"
          style="background: color-mix(in oklch, var(--color-secondary-500) 10%, transparent);"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--color-secondary-400);">
            <path d="M8 2v4" />
            <path d="M16 2v4" />
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M3 10h18" />
          </svg>
        </div>
        <p class="mb-2 text-lg font-medium text-surface-100">No digest articles yet</p>
        <p class="section-subtitle">There were no visible articles in the last 7 days.</p>
      </div>
    {:else}
      <div class="grid gap-8 lg:grid-cols-[1.45fr_1fr]">
        <section>
          <div class="mb-3 flex items-center justify-between gap-3">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-surface-100">
              Top Stories
            </h2>
            <span class="text-xs text-surface-300">Five representative reads</span>
          </div>

          <div class="space-y-3">
            {#each digest.topStories as story, i (story.article.id)}
              <a
                href="/articles/{story.article.id}?mode=app"
                class="block rounded-sm border p-4 transition-colors hover:border-primary-400/60"
                style="border-color: color-mix(in oklch, var(--color-surface-200) 12%, transparent); background: color-mix(in oklch, var(--color-surface-900) 28%, transparent);"
              >
                <div class="flex items-start gap-3">
                  <div class="flex-none pt-0.5 text-xs font-semibold text-primary-300">
                    {String(i + 1).padStart(2, '0')}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2 text-xs text-surface-300">
                      <span class="font-medium text-primary-300">
                        {story.article.feed_title || 'Unknown Feed'}
                      </span>
                      {#if !story.article.read}
                        <span
                          class="inline-flex items-center gap-1 rounded-sm bg-warning-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warning-300"
                        >
                          Unread
                        </span>
                      {/if}
                      {#if story.article.saved}
                        <span
                          class="inline-flex items-center gap-1 rounded-sm bg-success-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-success-300"
                        >
                          Saved
                        </span>
                      {/if}
                    </div>
                    <div class="mt-1 text-sm font-semibold leading-snug text-surface-50">
                      {story.article.title}
                    </div>
                    {#if story.reason}
                      <div class="mt-1 text-sm leading-relaxed text-surface-300">
                        {story.reason}
                      </div>
                    {/if}
                  </div>
                  <div class="flex-none pt-0.5 text-xs text-surface-300">Open</div>
                </div>
              </a>
            {/each}
          </div>

          <div class="mt-8 flex items-center justify-between gap-3">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-surface-100">
              Missed Stories
            </h2>
            <span class="text-xs text-surface-300">Two unread stories to check out</span>
          </div>

          <div class="mt-3 space-y-3">
            {#each digest.missedStories as story, i (story.article.id)}
              <a
                href="/articles/{story.article.id}?mode=app"
                class="block rounded-sm border p-4 transition-colors hover:border-primary-400/60"
                style="border-color: color-mix(in oklch, var(--color-surface-200) 12%, transparent); background: color-mix(in oklch, var(--color-surface-900) 22%, transparent);"
              >
                <div class="flex items-start gap-3">
                  <div class="flex-none pt-0.5 text-xs font-semibold text-secondary-300">
                    {String(i + 1).padStart(2, '0')}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2 text-xs text-surface-300">
                      <span class="font-medium text-secondary-300">
                        {story.article.feed_title || 'Unknown Feed'}
                      </span>
                      <span
                        class="inline-flex items-center gap-1 rounded-sm bg-secondary-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-secondary-300"
                      >
                        Unread pick
                      </span>
                    </div>
                    <div class="mt-1 text-sm font-semibold leading-snug text-surface-50">
                      {story.article.title}
                    </div>
                    {#if story.reason}
                      <div class="mt-1 text-sm leading-relaxed text-surface-300">
                        {story.reason}
                      </div>
                    {/if}
                  </div>
                </div>
              </a>
            {/each}
          </div>
        </section>

        <aside class="space-y-8">
          <section>
            <div class="mb-3 flex items-center justify-between gap-3">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-surface-100">
                Dominant Themes
              </h2>
              <span class="text-xs text-surface-300">Representative links</span>
            </div>

            <div class="space-y-4">
              {#each digest.themes as theme (theme.name)}
                <div
                  class="rounded-sm border p-4"
                  style="border-color: color-mix(in oklch, var(--color-surface-200) 12%, transparent); background: color-mix(in oklch, var(--color-surface-900) 24%, transparent);"
                >
                  <div class="text-sm font-semibold text-surface-50">{theme.name}</div>
                  <div class="mt-1 text-sm leading-relaxed text-surface-300">{theme.summary}</div>
                  <div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    {#each theme.articles as article, index (article.id)}
                      <a
                        href="/articles/{article.id}?mode=app"
                        class="text-primary-300 underline decoration-primary-500/30 underline-offset-2 hover:text-primary-200"
                      >
                        {article.title}
                      </a>
                      {#if index < theme.articles.length - 1}
                        <span class="text-surface-500">•</span>
                      {/if}
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          </section>

          <section>
            <div class="mb-3 flex items-center justify-between gap-3">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-surface-100">
                Sources That Drove the Week
              </h2>
              <span class="text-xs text-surface-300">Most active feeds</span>
            </div>

            <div class="space-y-2">
              {#each digest.activeFeeds as feed}
                <div
                  class="flex items-center justify-between gap-3 rounded-sm border px-3 py-2 text-sm"
                  style="border-color: color-mix(in oklch, var(--color-surface-200) 10%, transparent); background: color-mix(in oklch, var(--color-surface-900) 18%, transparent);"
                >
                  <span class="min-w-0 truncate text-surface-100">{feed.title}</span>
                  <span class="flex-none text-xs text-surface-300">{feed.count}</span>
                </div>
              {/each}
            </div>
          </section>
        </aside>
      </div>
    {/if}
  {/if}
</div>
