<script lang="ts">
  import { onMount } from 'svelte';
  import { addToast } from '#lib/stores/toast.svelte.ts';
  import PullToRefresh from '#lib/components/PullToRefresh.svelte';
  import ArticleList from '#lib/components/ArticleList.svelte';
  import { syncFeed } from '#lib/feeds.ts';
  import { ARTICLE_OPEN_MODES } from '#lib/constants/article-open-modes.ts';
  import { fly, fade } from 'svelte/transition';
  import { goto, refreshAll } from '$app/navigation';
  import { page as pageStore } from '$app/state';
  import { fetchWithCsrf } from '#lib/client/csrf.ts';
  import { reconcileCachedFeed } from '#lib/offline/index.ts';

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
    url?: string;
    id?: string;
    title?: string | null;
    category?: string | null;
    enabled?: boolean;
    error_count: number;
    last_error?: string | null;
    open_mode?: string | null;
    poll_interval_mins?: number | null;
    use_proxy?: boolean | number | null;
    source_type?: string | null;
    source_metadata?: string | null;
  };

  let { data: pageData } = $props<{
    data: {
      articles: FeedArticle[];
      feed: FeedData;
      feedId: string;
      page: number;
      totalPages: number;
      hiddenContentLimit?: number | null;
      showHiddenContent?: boolean;
      unreadOnly?: boolean;
      sort?: 'ranked' | 'newest' | 'oldest';
      snapshotAt?: number;
      proxyAvailable?: boolean;
    };
  }>();

  type ArticleSort = 'ranked' | 'newest' | 'oldest';
  const SORT_OPTIONS: Array<{ value: ArticleSort; label: string }> = [
    { value: 'ranked', label: 'Ranked' },
    { value: 'newest', label: 'Newest' },
    { value: 'oldest', label: 'Oldest' },
  ];

  let articles = $state<FeedArticle[]>([]);
  let feed = $state<FeedData>({ error_count: 0 });
  let showSettings = $state(false);
  let saving = $state(false);
  let deleting = $state(false);
  let clearing = $state(false);
  let saveSuccess = $state(false);

  // Settings form state
  let title = $state('');
  let feedUrl = $state('');
  let saveError = $state('');
  let category = $state('');
  let enabled = $state(true);
  let openMode = $state('');
  let pollInterval = $state('');
  let useProxy = $state(false);

  let syncing = $state(false);
  let newArticlesAvailable = $state(false);
  let newArticlesCount = $state(0);

  const currentSort = $derived<ArticleSort>(pageData.sort || 'ranked');
  const currentUnreadOnly = $derived(Boolean(pageData.unreadOnly));
  const loadMoreSearchParams = $derived.by(() => {
    const params: Record<string, string> = {};
    if (pageData.snapshotAt) params.snapshotAt = String(pageData.snapshotAt);
    if (currentUnreadOnly) params.unread = '1';
    if (currentSort !== 'ranked') params.sort = currentSort;
    return params;
  });

  function setUnreadFilter(nextUnreadOnly: boolean) {
    const next = new URL(window.location.href);
    if (nextUnreadOnly) {
      next.searchParams.set('unread', '1');
    } else {
      next.searchParams.delete('unread');
    }
    next.searchParams.delete('page');
    void goto(`${next.pathname}${next.search}`, {
      replace: true,
      reset: false,
    });
  }

  function setSort(nextSort: ArticleSort) {
    const next = new URL(window.location.href);
    if (nextSort === 'ranked') {
      next.searchParams.delete('sort');
    } else {
      next.searchParams.set('sort', nextSort);
    }
    next.searchParams.delete('page');
    void goto(`${next.pathname}${next.search}`, {
      replace: true,
      reset: false,
    });
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
      replace: true,
      reset: false,
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

  // Count refreshes can replace page data while reusing the loaded articles.
  const loadedArticles = $derived(pageData.articles);
  let lastLoadedArticles: FeedArticle[] | null = null;

  $effect(() => {
    if (loadedArticles !== lastLoadedArticles) {
      lastLoadedArticles = loadedArticles;
      articles = loadedArticles;
    }
  });

  $effect(() => {
    feed = pageData.feed;
    title = String(pageData.feed.title ?? '');
    feedUrl = pageData.feed.url ?? '';
    category = String(pageData.feed.category ?? '');
    enabled = !!pageData.feed.enabled;
    openMode = pageData.feed.open_mode ?? '';
    pollInterval =
      pageData.feed.poll_interval_mins == null
        ? ''
        : String(pageData.feed.poll_interval_mins);
    useProxy = Boolean(pageData.feed.use_proxy);
  });

  onMount(() => {
    const handleNewArticles = () => {
      newArticlesAvailable = true;
    };
    window.addEventListener('feed-me-maybe:new-articles', handleNewArticles);
    return () => {
      window.removeEventListener(
        'feed-me-maybe:new-articles',
        handleNewArticles,
      );
    };
  });

  async function loadNewArticles() {
    newArticlesAvailable = false;
    newArticlesCount = 0;
    if (pageData.page > 1) {
      await goto(`/feeds/${pageData.feedId}`, { replaceState: false });
    }
    await refreshAll();
  }

  async function handleSync() {
    if (syncing) return;
    syncing = true;
    newArticlesAvailable = false;
    newArticlesCount = 0;
    const previousIds = new Set(articles.map((article) => article.id));
    try {
      const result = await syncFeed(pageData.feedId);
      if (result === 'completed') {
        await refreshAll();
        const added = pageData.articles.filter(
          (article: FeedArticle) => !previousIds.has(article.id),
        ).length;
        if (added > 0 || pageData.page > 1) {
          newArticlesCount = added;
          newArticlesAvailable = added > 0;
        }
      } else if (result === 'pending') {
        newArticlesAvailable = true;
      }
    } finally {
      syncing = false;
    }
  }

  async function saveSettings() {
    saving = true;
    saveSuccess = false;
    saveError = '';
    try {
      const payload: Record<string, unknown> = {
        url: feedUrl,
        category,
        enabled,
        open_mode: openMode || null,
        use_proxy: useProxy,
      };
      if (title.trim() !== String(feed.title ?? '').trim()) {
        payload.title = title;
      }
      const trimmedInterval = pollInterval.trim();
      if (trimmedInterval === '') {
        payload.poll_interval_mins = null;
      } else {
        const parsedInterval = Number(trimmedInterval);
        if (
          !Number.isInteger(parsedInterval) ||
          parsedInterval < 1 ||
          parsedInterval > 1440
        ) {
          throw new Error(
            'Poll interval must be a whole number from 1 to 1440 minutes.',
          );
        }
        payload.poll_interval_mins = parsedInterval;
      }

      const res = await fetchWithCsrf(`/api/feeds/${pageData.feedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        saveSuccess = true;
        const data = await res.json();
        if (data.feed) {
          feed = data.feed;
          title = data.feed.title || '';
          feedUrl = data.feed.url || '';
          category = data.feed.category || '';
          enabled = !!data.feed.enabled;
          openMode = data.feed.open_mode ?? '';
          pollInterval =
            data.feed.poll_interval_mins == null
              ? ''
              : String(data.feed.poll_interval_mins);
          useProxy = Boolean(data.feed.use_proxy);
        }
        await reconcileCachedFeed(
          String(pageStore.data.userId || 'admin'),
          pageData.feedId,
          {
            type: 'update',
            enabled,
            title,
            openMode: openMode || null,
          },
        ).catch(() => undefined);
        await refreshAll();
        setTimeout(() => {
          saveSuccess = false;
        }, 2000);
      } else {
        const result = await res.json().catch(() => null);
        throw new Error(result?.error || 'Failed to save settings');
      }
    } catch (error) {
      saveError =
        error instanceof Error ? error.message : 'Failed to save settings';
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
      const res = await fetchWithCsrf(`/api/feeds/${pageData.feedId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await reconcileCachedFeed(
          String(pageStore.data.userId || 'admin'),
          pageData.feedId,
          { type: 'delete' },
        ).catch(() => undefined);
        addToast('Feed deleted', 'success');
        await goto('/');
        await refreshAll();
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
        'Hide all unsaved articles currently in this feed? Saved articles will stay visible, and new articles will still sync.',
      )
    ) {
      return;
    }

    clearing = true;
    try {
      const res = await fetchWithCsrf(`/api/feeds/${pageData.feedId}/clear`, {
        method: 'POST',
      });
      if (res.ok) {
        await reconcileCachedFeed(
          String(pageStore.data.userId || 'admin'),
          pageData.feedId,
          { type: 'clear' },
        ).catch(() => undefined);
        addToast('Feed items cleared', 'success');
        await refreshAll();
      } else {
        throw new Error();
      }
    } catch {
      addToast('Failed to clear feed items', 'error');
    } finally {
      clearing = false;
    }
  }

  const settingsIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>`;
</script>

<svelte:head>
  <title>{feed.title || 'Feed'} · Feed Me Maybe</title>
</svelte:head>

<PullToRefresh onSync={handleSync} {syncing}>
  <div
    class="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between"
  >
    <div class="min-w-0 flex-1">
      <h1 class="section-title break-words">{feed.title || 'Untitled Feed'}</h1>
      {#if feed.source_type === 'reddit'}
        {@const meta = parseRedditMeta(feed.source_metadata)}
        {#if meta}
          <div
            class="mt-1 flex flex-wrap items-center gap-2 text-xs"
            style="color: var(--color-surface-300);"
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
              <span class="capitalize">{meta.redditKind.replace('_', ' ')}</span
              >
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
      {#if feed.error_count > 0}
        <p class="mt-3 break-words text-sm text-error-300">
          {feed.error_count} failed {feed.error_count === 1
            ? 'attempt'
            : 'attempts'}
          {#if feed.last_error}<span class="block">{feed.last_error}</span>{/if}
        </p>
      {/if}
    </div>

    <div class="flex flex-wrap items-center gap-2 md:justify-end">
      <button
        type="button"
        class="btn preset-filled-surface-200-800 h-10 px-3"
        onclick={handleSync}
        disabled={syncing}
        aria-busy={syncing}
      >
        {syncing ? 'Refreshing…' : 'Refresh feed'}
      </button>
      <button
        type="button"
        class="btn flex h-10 w-10 items-center justify-center p-0 md:h-auto md:w-auto md:px-4 md:py-2 md:gap-2"
        class:preset-filled-primary-500={pageData.showHiddenContent}
        class:preset-filled-surface-200-800={!pageData.showHiddenContent}
        onclick={toggleHiddenContent}
        aria-label="Show hidden articles"
        aria-pressed={Boolean(pageData.showHiddenContent)}
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
            <path
              d="M6.228 6.228A11 11 0 0 0 2 12c1.5 3.5 5.5 7 10 7 1.223 0 2.37-.184 3.428-.514"
            />
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
        type="button"
        class="btn preset-filled-surface-200-800 flex h-10 w-10 items-center justify-center p-0 md:h-auto md:w-auto md:px-4 md:py-2 md:gap-2"
        onclick={() => (showSettings = !showSettings)}
        aria-label="Settings"
        aria-expanded={showSettings}
        title="Settings"
      >
        {@html settingsIcon}
        <span class="hidden md:inline">Settings</span>
      </button>
    </div>
  </div>

  {#if pageData.showHiddenContent}
    <div
      class="mb-6 overflow-hidden rounded-sm border"
      style="border-color: color-mix(in oklch, var(--color-secondary-500) 18%, transparent); background: linear-gradient(135deg, color-mix(in oklch, var(--color-secondary-500) 14%, transparent), color-mix(in oklch, var(--color-primary-500) 8%, transparent));"
    >
      <div
        class="flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between md:p-5"
      >
        <div class="flex min-w-0 items-start gap-3">
          <div
            class="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
            style="background: color-mix(in oklch, var(--color-secondary-500) 16%, transparent); color: var(--color-secondary-300);"
          >
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
                d="m12 2 2.9 6.2L21 10l-6 3.8L16.7 20 12 16.7 7.3 20 8 13.8 2 10l6.1-1.8Z"
              />
            </svg>
          </div>
          <div class="min-w-0">
            <p class="text-sm font-semibold text-surface-50">
              Auto-hidden review
            </p>
            <p
              class="mt-1 max-w-2xl text-sm"
              style="color: color-mix(in oklch, var(--color-surface-100) 84%, transparent);"
            >
              These are the {pageData.hiddenContentLimit || 30} most recent articles
              the model hid automatically. Use <strong>Keep &amp; boost</strong> to
              restore a story to your feeds and give it a much stronger positive signal
              than a standard thumbs-up.
            </p>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span
            class="inline-flex items-center gap-1 px-2 py-1 font-medium"
            style="border-radius: 2px; background: color-mix(in oklch, var(--color-secondary-500) 12%, transparent); color: var(--color-secondary-200);"
          >
            Review queue
          </span>
          <span
            class="inline-flex items-center gap-1 px-2 py-1 font-medium"
            style="border-radius: 2px; background: color-mix(in oklch, var(--color-primary-500) 12%, transparent); color: var(--color-primary-200);"
          >
            Boost removes it from this view
          </span>
        </div>
      </div>
    </div>
  {/if}

  {#if showSettings}
    <div class="glass-card mb-12 p-6" in:fly={{ y: -10, duration: 200 }}>
      <p class="text-error-300" role="alert">{saveError}</p>
      <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
        <label class="label">
          <span class="mb-1 block text-sm font-medium">Title</span>
          <input class="input glass-input" type="text" bind:value={title} />
        </label>
        <label class="label">
          <span class="mb-1 block text-sm font-medium">Feed URL</span>
          <input
            class="input glass-input"
            type="url"
            bind:value={feedUrl}
            required
          />
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
        <label class="label">
          <span class="mb-1 block text-sm font-medium"
            >Poll Interval (minutes)</span
          >
          <input
            class="input glass-input"
            type="number"
            min="1"
            max="1440"
            bind:value={pollInterval}
            placeholder="Use global default"
          />
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
            <p class="text-xs" style="color: var(--color-surface-300);">
              Set <code>PROXY_BASE_URL</code> to enable proxy fetching for this feed.
            </p>
          {/if}
        </div>
      </div>
      <div class="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-4">
          <button
            class="btn preset-filled-primary-500"
            onclick={saveSettings}
            disabled={saving}
            aria-busy={saving}
            type="button"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          {#if saveSuccess}
            <span class="text-sm text-success-400" role="status" in:fade
              >Settings saved!</span
            >
          {/if}
        </div>
        <div class="flex flex-wrap items-center gap-3">
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

  {#if newArticlesAvailable}
    <div
      class="glass-card mb-6 flex flex-wrap items-center justify-between gap-3 p-4"
      role="status"
      aria-live="polite"
    >
      <span class="text-sm text-surface-100">
        {newArticlesCount > 0
          ? `${newArticlesCount} new ${newArticlesCount === 1 ? 'article' : 'articles'} synced.`
          : 'New articles may be ready for this feed.'}
      </span>
      <button
        type="button"
        class="btn preset-filled-primary-500 px-3 py-1.5 text-xs"
        onclick={() => void loadNewArticles()}
      >
        Load new articles
      </button>
    </div>
  {/if}

  {#if !pageData.showHiddenContent}
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div
        class="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label="Filter feed articles"
      >
        <button
          type="button"
          class="rounded-full border px-3 py-1.5 text-xs font-semibold transition {!currentUnreadOnly
            ? 'border-primary-400/40 bg-primary-500/15 text-primary-200'
            : 'border-white/10 bg-white/5 text-surface-300 hover:border-white/20 hover:text-surface-200'}"
          aria-pressed={!currentUnreadOnly}
          onclick={() => setUnreadFilter(false)}>All</button
        >
        <button
          type="button"
          class="rounded-full border px-3 py-1.5 text-xs font-semibold transition {currentUnreadOnly
            ? 'border-primary-400/40 bg-primary-500/15 text-primary-200'
            : 'border-white/10 bg-white/5 text-surface-300 hover:border-white/20 hover:text-surface-200'}"
          aria-pressed={currentUnreadOnly}
          onclick={() => setUnreadFilter(true)}>Unread</button
        >
      </div>
      <div
        class="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label="Sort feed articles"
      >
        {#each SORT_OPTIONS as option (option.value)}
          <button
            type="button"
            class="rounded-full border px-3 py-1.5 text-xs font-semibold transition {currentSort ===
            option.value
              ? 'border-primary-400/40 bg-primary-500/15 text-primary-200'
              : 'border-white/10 bg-white/5 text-surface-300 hover:border-white/20 hover:text-surface-200'}"
            aria-pressed={currentSort === option.value}
            onclick={() => setSort(option.value)}>{option.label}</button
          >
        {/each}
      </div>
    </div>
  {/if}

  {#key `${pageData.feedId}:${currentUnreadOnly}:${currentSort}:${Boolean(pageData.showHiddenContent)}`}
    <ArticleList
      bind:articles
      totalPages={pageData.totalPages}
      feedId={pageData.feedId}
      liveUpdates={!pageData.showHiddenContent}
      {loadMoreSearchParams}
      showInfiniteScroll={!pageData.showHiddenContent}
      feedbackMode={pageData.showHiddenContent ? 'boost' : 'standard'}
      emptyTitle={pageData.showHiddenContent
        ? 'No auto-hidden articles yet'
        : currentUnreadOnly
          ? 'No unread articles in this feed'
          : undefined}
      emptyMessage={pageData.showHiddenContent
        ? 'This feed has not produced any model-hidden items yet.'
        : currentUnreadOnly
          ? 'You are all caught up on this feed.'
          : undefined}
      emptyCtaHref={pageData.showHiddenContent || currentUnreadOnly
        ? null
        : undefined}
    />
  {/key}
</PullToRefresh>
