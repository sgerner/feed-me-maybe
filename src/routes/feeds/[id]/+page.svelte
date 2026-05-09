<script lang="ts">
  import { addToast } from '$lib/stores/toast.svelte';
  import ArticleList from '$lib/components/ArticleList.svelte';
  import { syncFeed } from '$lib/feeds';
  import { ARTICLE_OPEN_MODES } from '$lib/constants/article-open-modes';
  import { fly, fade } from 'svelte/transition';
  import { goto } from '$app/navigation';

  type FeedArticle = {
    id: string;
    url: string;
    title: string;
    author?: string | null;
    summary?: string | null;
    image_url?: string | null;
    categories?: string | null;
    published_at?: number | null;
    fetched_at?: number | null;
    read?: boolean;
    saved?: boolean;
    hidden?: boolean;
    heuristic_score?: number | null;
    combined_score?: number | null;
    feed_title?: string | null;
    feed_url?: string | null;
    feed_open_mode?: string | null;
  };

  type FeedData = {
    id?: string;
    title?: string | null;
    category?: string | null;
    enabled?: boolean;
    open_mode?: string | null;
    use_proxy?: boolean | number | null;
    source_type?: string | null;
    source_metadata?: string | null;
  };

  let { data: pageData } = $props<{
    data: {
      articles: FeedArticle[];
      feed: FeedData;
      feedId: string;
      totalPages: number;
      hiddenContentLimit?: number | null;
      showHiddenContent?: boolean;
      proxyAvailable?: boolean;
    };
  }>();

  let articles = $state<FeedArticle[]>([]);
  let feed = $state<FeedData>({});
  let showSettings = $state(false);
  let saving = $state(false);
  let deleting = $state(false);
  let clearing = $state(false);
  let saveSuccess = $state(false);

  // Settings form state
  let title = $state('');
  let category = $state('');
  let enabled = $state(true);
  let openMode = $state('');
  let useProxy = $state(false);

  let pullDistance = $state(0);
  let isPulling = $state(false);
  let syncing = $state(false);
  let touchStartY = 0;

  function getScrollContainer(): HTMLElement | null {
    return document.querySelector('main');
  }

  function isAtTop(): boolean {
    const container = getScrollContainer();
    return !container || container.scrollTop <= 0;
  }

  function toggleHiddenContent() {
    const next = new URL(window.location.href);
    if (pageData.showHiddenContent) {
      next.searchParams.delete('showHidden');
    } else {
      next.searchParams.set('showHidden', '1');
    }
    next.searchParams.delete('page');
    goto(`${next.pathname}${next.search}`, {
      replaceState: true,
      noScroll: true,
    });
  }

  function parseRedditMeta(meta: string | null | undefined) {
    if (!meta) return null;
    try {
      return JSON.parse(meta) as {
        redditKind?: string;
        subreddit?: string;
        username?: string;
        query?: string;
        originalUrl?: string;
      };
    } catch {
      return null;
    }
  }

  $effect(() => {
    articles = pageData.articles;
    feed = pageData.feed;
    title = String(pageData.feed.title ?? '');
    category = String(pageData.feed.category ?? '');
    enabled = !!pageData.feed.enabled;
    openMode = pageData.feed.open_mode ?? '';
    useProxy = Boolean(pageData.feed.use_proxy);
  });

  async function handleSync() {
    if (syncing) return;
    syncing = true;
    await syncFeed(pageData.feedId);
    syncing = false;
  }

  async function saveSettings() {
    saving = true;
    saveSuccess = false;
    try {
      const res = await fetch(`/api/feeds/${pageData.feedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          category,
          enabled,
          open_mode: openMode || null,
          use_proxy: useProxy,
        }),
      });
      if (res.ok) {
        saveSuccess = true;
        const data = await res.json();
        if (data.feed) {
          feed = data.feed;
          title = data.feed.title || '';
          category = data.feed.category || '';
          enabled = !!data.feed.enabled;
          openMode = data.feed.open_mode ?? '';
          useProxy = Boolean(data.feed.use_proxy);
        }
        setTimeout(() => {
          saveSuccess = false;
        }, 2000);
      } else {
        throw new Error();
      }
    } catch {
      addToast('Failed to save settings', 'error');
    } finally {
      saving = false;
    }
  }

  async function deleteFeed() {
    if (
      !confirm(
        'Are you sure you want to delete this feed? All articles will be removed.',
      )
    ) {
      return;
    }

    deleting = true;
    try {
      const res = await fetch(`/api/feeds/${pageData.feedId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        addToast('Feed deleted', 'success');
        goto('/');
      } else {
        throw new Error();
      }
    } catch {
      addToast('Failed to delete feed', 'error');
    } finally {
      deleting = false;
    }
  }

  async function clearFeedItems() {
    if (
      !confirm(
        'Remove all current articles from this feed? This will not clear your learned preferences.',
      )
    ) {
      return;
    }

    clearing = true;
    try {
      const res = await fetch(`/api/feeds/${pageData.feedId}/clear`, {
        method: 'POST',
      });
      if (res.ok) {
        addToast('Feed items cleared', 'success');
        window.location.reload();
      } else {
        throw new Error();
      }
    } catch {
      addToast('Failed to clear feed items', 'error');
    } finally {
      clearing = false;
    }
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
      handleSync();
    }
    pullDistance = 0;
    isPulling = false;
  }

  const settingsIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>`;
</script>

<div
  class="mx-auto max-w-7xl"
  role="presentation"
  style="overscroll-behavior-y: contain; touch-action: pan-y;"
  ontouchstart={handleTouchStart}
  ontouchmove={handleTouchMove}
  ontouchend={handleTouchEnd}
>
  <!-- Pull to refresh indicator -->
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
      <span class="text-xs font-bold uppercase tracking-wider"
        >{pullDistance >= 60 ? 'Release to sync' : 'Pull to sync'}</span
      >
    </div>
  </div>

  <div class="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
    <div class="min-w-0 flex-1">
      <h1 class="section-title break-words">{feed.title || 'Untitled Feed'}</h1>
      {#if feed.source_type === 'reddit'}
        {@const meta = parseRedditMeta(feed.source_metadata)}
        {#if meta}
          <div
            class="mt-1 flex flex-wrap items-center gap-2 text-xs"
            style="color: color-mix(in oklch, var(--color-surface-200) 55%, transparent);"
          >
            <span
              class="inline-flex items-center gap-1 px-1.5 py-0.5 font-medium"
              style="background: color-mix(in oklch, var(--color-primary-500) 10%, transparent); color: var(--color-primary-300); border-radius: 2px;"
              >Reddit</span
            >
            {#if meta.subreddit}
              <span>{meta.subreddit}</span>
            {/if}
            {#if meta.username}
              <span>u/{meta.username}</span>
            {/if}
            {#if meta.query}
              <span>Search: {meta.query}</span>
            {/if}
            {#if meta.redditKind}
              <span class="capitalize">{meta.redditKind.replace('_', ' ')}</span>
            {/if}
          </div>
        {/if}
      {/if}

      <div class="mt-3 flex flex-wrap items-center gap-2">
        {#if !feed.enabled}
          <span
            class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style="background: color-mix(in oklch, var(--color-warning-500) 12%, transparent); color: var(--color-warning-300); border-radius: 2px;"
            >Disabled</span
          >
        {/if}
        {#if feed.use_proxy}
          <span
            class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style="background: color-mix(in oklch, var(--color-primary-500) 12%, transparent); color: var(--color-primary-300); border-radius: 2px;"
            >Proxy</span
          >
        {/if}
        {#if pageData.showHiddenContent}
          <span
            class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
            style="background: color-mix(in oklch, var(--color-secondary-500) 12%, transparent); color: var(--color-secondary-300); border-radius: 2px;"
          >
            Hidden · {pageData.hiddenContentLimit || 30} recent
          </span>
        {/if}
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2 md:justify-end">
      <button
        class="btn flex h-10 w-10 items-center justify-center p-0 md:h-auto md:w-auto md:px-4 md:py-2 md:gap-2"
        class:preset-filled-primary-500={pageData.showHiddenContent}
        class:preset-filled-surface-200-800={!pageData.showHiddenContent}
        onclick={toggleHiddenContent}
        aria-label={pageData.showHiddenContent ? 'Show Feed' : 'Show Hidden'}
        title={pageData.showHiddenContent ? 'Show Feed' : 'Show Hidden'}
      >
        {#if pageData.showHiddenContent}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              d="M3.98 8.223A10.94 10.94 0 0 1 12 5c5.5 0 9.5 3.5 11 7a10.94 10.94 0 0 1-4.203 5.277"
            />
            <path d="M6.228 6.228A11 11 0 0 0 2 12c1.5 3.5 5.5 7 10 7 1.223 0 2.37-.184 3.428-.514" />
            <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" />
            <path d="m1 1 22 22" />
          </svg>
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
            <path
              d="M2.062 12.348a1 1 0 0 1 0-.696 11 11 0 0 1 19.876 0 1 1 0 0 1 0 .696 11 11 0 0 1-19.876 0"
            />
            <path d="M10 10a3 3 0 1 0 4 4" />
          </svg>
        {/if}
        <span class="hidden md:inline">
          {pageData.showHiddenContent ? 'Show Feed' : 'Show Hidden'}
        </span>
      </button>
      <button
        class="btn preset-filled-surface-200-800 flex h-10 w-10 items-center justify-center p-0 md:h-auto md:w-auto md:px-4 md:py-2 md:gap-2"
        onclick={() => (showSettings = !showSettings)}
        aria-label="Settings"
        title="Settings"
      >
        {@html settingsIcon}
        <span class="hidden md:inline">Settings</span>
      </button>
    </div>
  </div>

  {#if pageData.showHiddenContent}
    <div
      class="mb-6 rounded-sm border px-4 py-3 text-sm"
      style="border-color: color-mix(in oklch, var(--color-secondary-500) 18%, transparent); background: color-mix(in oklch, var(--color-secondary-500) 7%, transparent); color: color-mix(in oklch, var(--color-surface-100) 88%, transparent);"
    >
      Showing the {pageData.hiddenContentLimit || 30} most recent auto-hidden
      articles. Manually hidden articles and hide-on-open items are excluded.
    </div>
  {/if}

  {#if showSettings}
    <div class="glass-card mb-12 p-6" in:fly={{ y: -10, duration: 200 }}>
      <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
        <label class="label">
          <span class="mb-1 block text-sm font-medium">Title</span>
          <input class="input glass-input" type="text" bind:value={title} />
        </label>
        <label class="label">
          <span class="mb-1 block text-sm font-medium">Category</span>
          <input
            class="input glass-input"
            type="text"
            bind:value={category}
            placeholder="e.g., Technology, News"
          />
        </label>
        <label class="label">
          <span class="mb-1 block text-sm font-medium">Open Mode Override</span>
          <select class="select glass-input" bind:value={openMode}>
            <option value="">Use Global Default</option>
            {#each ARTICLE_OPEN_MODES as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <label class="flex items-center gap-3 pt-5">
          <input type="checkbox" bind:checked={enabled} class="checkbox" />
          <span class="text-sm">Feed enabled</span>
        </label>
        <div class="flex flex-col gap-2 pt-5">
          <label class="flex items-center gap-3">
            <input
              type="checkbox"
              bind:checked={useProxy}
              class="checkbox"
              disabled={!pageData.proxyAvailable}
            />
            <span class="text-sm">Fetch through proxy</span>
          </label>
          {#if !pageData.proxyAvailable}
            <p
              class="text-xs"
              style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);"
            >
              Set <code>PROXY_BASE_URL</code> to enable proxy fetching for
              this feed.
            </p>
          {/if}
        </div>
      </div>
      <div class="mt-6 flex items-center justify-between">
        <div class="flex items-center gap-4">
          <button
            class="btn preset-filled-primary-500"
            onclick={saveSettings}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          {#if saveSuccess}
            <span class="text-sm text-success-400" in:fade>Settings saved!</span
            >
          {/if}
        </div>
        <div class="flex items-center gap-3">
          <button
            class="btn action-btn"
            style="border-color: color-mix(in oklch, var(--color-warning-500) 20%, transparent); background: color-mix(in oklch, var(--color-warning-500) 10%, transparent); color: var(--color-warning-300);"
            onclick={clearFeedItems}
            disabled={clearing}
          >
            {clearing ? 'Clearing...' : 'Clear Items'}
          </button>
          <button
            class="btn preset-tonal-error"
            onclick={deleteFeed}
            disabled={deleting}
          >
            {deleting ? 'Deleting...' : 'Delete Feed'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <ArticleList
    bind:articles
    totalPages={pageData.totalPages}
    feedId={pageData.feedId}
    showInfiniteScroll={!pageData.showHiddenContent}
    emptyTitle={
      pageData.showHiddenContent ? 'No auto-hidden articles yet' : undefined
    }
    emptyMessage={
      pageData.showHiddenContent
        ? 'This feed has not produced any model-hidden items yet.'
        : undefined
    }
    emptyCtaHref={pageData.showHiddenContent ? null : undefined}
  />
</div>
