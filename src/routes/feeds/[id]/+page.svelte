<script lang="ts">
  import { addToast } from '$lib/stores/toast.svelte';
  import ArticleList from '$lib/components/ArticleList.svelte';
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
    source_type?: string | null;
    source_metadata?: string | null;
  };

  let { data: pageData } = $props<{
    data: {
      articles: FeedArticle[];
      feed: FeedData;
      feedId: string;
      totalPages: number;
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

  let pullDistance = $state(0);
  let isPulling = $state(false);
  let syncing = $state(false);
  let touchStartY = 0;

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
  });

  async function syncFeed() {
    if (syncing) return;
    syncing = true;
    try {
      const res = await fetch(`/api/feeds/${pageData.feedId}/refresh`, {
        method: 'POST',
      });
      if (res.ok) {
        addToast('Syncing feed...', 'success');
        // Refresh article list could be done here if needed,
        // but background sync doesn't return articles.
      }
    } catch {
      addToast('Sync failed', 'error');
    } finally {
      syncing = false;
    }
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
    if (window.scrollY <= 0) {
      isPulling = true;
      touchStartY = e.changedTouches[0].screenY;
    }
  }

  function handleTouchMove(e: TouchEvent) {
    if (!isPulling) return;
    const currentY = e.changedTouches[0].screenY;
    const diff = currentY - touchStartY;
    if (diff > 0) {
      pullDistance = Math.min(diff * 0.4, 80);
    } else {
      pullDistance = 0;
      isPulling = false;
    }
  }

  function handleTouchEnd() {
    if (isPulling && pullDistance >= 60) {
      syncFeed();
    }
    pullDistance = 0;
    isPulling = false;
  }
</script>

<div
  class="mx-auto max-w-7xl"
  role="presentation"
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

  <div class="mb-8 flex items-center justify-between">
    <div class="flex items-center gap-4">
      <div>
        <h1 class="section-title">{feed.title || 'Untitled Feed'}</h1>
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
                <span class="capitalize"
                  >{meta.redditKind.replace('_', ' ')}</span
                >
              {/if}
            </div>
          {/if}
        {/if}
      </div>
      {#if !feed.enabled}
        <span
          class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style="background: color-mix(in oklch, var(--color-warning-500) 12%, transparent); color: var(--color-warning-300); border-radius: 2px;"
          >Disabled</span
        >
      {/if}
    </div>
    <button
      class="btn preset-filled-surface-200-800 flex items-center gap-2"
      onclick={() => (showSettings = !showSettings)}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        ><path
          d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        /><circle cx="12" cy="12" r="3" /></svg
      >
      Settings
    </button>
  </div>

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
  />
</div>
