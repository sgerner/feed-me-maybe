<script lang="ts">
  import { getContext } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { fade, fly } from 'svelte/transition';
  import { refreshAll } from '$app/navigation';
  import { fetchWithCsrf } from '#lib/client/csrf.ts';
  import { addToast } from '#lib/stores/toast.svelte.ts';

  type Feed = {
    id: string;
    url: string;
    title?: string | null;
    category?: string | null;
    icon_url?: string | null;
    enabled: boolean | number;
    error_count: number;
    last_fetch_status?: string | null;
    last_fetch_at?: number | null;
    last_error?: string | null;
    poll_interval_mins?: number | null;
    health_status?: string;
    health_stale?: boolean;
    unread_count: number;
    saved_count?: number;
    visible_count: number;
    article_count: number;
  };

  type StatusFilter = 'all' | 'active' | 'paused' | 'errored';

  let { data }: { data: { feeds: Feed[]; totalUnread?: number } } = $props();
  let query = $state('');
  let statusFilter = $state<StatusFilter>('all');
  let selectedIds = $state<string[]>([]);
  let batchCategory = $state('');
  let batchPending = $state(false);
  let confirmingBatchDelete = $state(false);
  let importingOpml = $state(false);
  let editingCategoryFeedId = $state<string | null>(null);
  let editingCategoryValue = $state('');
  let savingCategory = $state(false);

  const openAddFeed = getContext<() => void>('openAddFeed');

  $effect(() => {
    const validIds = new Set(data.feeds.map((feed) => feed.id));
    const pruned = selectedIds.filter((id) => validIds.has(id));
    if (pruned.length !== selectedIds.length) {
      selectedIds = pruned;
    }
  });

  function isErroredFeed(feed: Feed): boolean {
    return (
      feed.health_status === 'error' ||
      Number(feed.error_count || 0) > 0 ||
      feed.last_fetch_status === 'error'
    );
  }

  function matchesStatusFilter(feed: Feed, filter: StatusFilter): boolean {
    if (filter === 'active') return Boolean(feed.enabled);
    if (filter === 'paused') return !feed.enabled;
    if (filter === 'errored') return isErroredFeed(feed);
    return true;
  }

  const statusCounts = $derived({
    all: data.feeds.length,
    active: data.feeds.filter((feed) => Boolean(feed.enabled)).length,
    paused: data.feeds.filter((feed) => !feed.enabled).length,
    errored: data.feeds.filter((feed) => isErroredFeed(feed)).length,
  });

  const existingCategories = $derived(
    Array.from(
      new Set(
        data.feeds
          .map((feed) => feed.category?.trim() || '')
          .filter((value) => value.length > 0),
      ),
    ).sort((a, b) => a.localeCompare(b)),
  );

  const filteredFeeds = $derived(
    data.feeds.filter((feed) => {
      if (!matchesStatusFilter(feed, statusFilter)) return false;
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return [feed.title, feed.url, feed.category]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    }),
  );

  const groupedFeeds = $derived.by(() => {
    const groups: Record<string, Feed[]> = Object.create(null);
    for (const feed of filteredFeeds) {
      const name = feed.category?.trim() || 'Unsorted';
      const group = groups[name] || (groups[name] = []);
      group.push(feed);
    }
    return Object.entries(groups);
  });

  const totalUnread = $derived(
    data.feeds.reduce(
      (sum, feed) =>
        feed.enabled ? sum + Number(feed.unread_count || 0) : sum,
      0,
    ),
  );
  const filteredUnread = $derived(
    filteredFeeds.reduce(
      (sum, feed) =>
        feed.enabled ? sum + Number(feed.unread_count || 0) : sum,
      0,
    ),
  );

  const selectedSet = $derived(new Set(selectedIds));
  const selectedSavedCount = $derived(
    data.feeds.reduce(
      (sum, feed) =>
        selectedSet.has(feed.id) ? sum + Number(feed.saved_count || 0) : sum,
      0,
    ),
  );
  const allFilteredSelected = $derived(
    filteredFeeds.length > 0 &&
      filteredFeeds.every((feed) => selectedSet.has(feed.id)),
  );

  function toggleSelect(feedId: string) {
    confirmingBatchDelete = false;
    if (selectedSet.has(feedId)) {
      selectedIds = selectedIds.filter((id) => id !== feedId);
    } else {
      selectedIds = [...selectedIds, feedId];
    }
  }

  function toggleSelectAllFiltered() {
    confirmingBatchDelete = false;
    if (allFilteredSelected) {
      const filteredSet = new Set(filteredFeeds.map((feed) => feed.id));
      selectedIds = selectedIds.filter((id) => !filteredSet.has(id));
    } else {
      const merged = new SvelteSet(selectedIds);
      for (const feed of filteredFeeds) merged.add(feed.id);
      selectedIds = [...merged];
    }
  }

  function clearSelection() {
    selectedIds = [];
    batchCategory = '';
    confirmingBatchDelete = false;
  }

  function requestBatchDelete() {
    if (selectedIds.length === 0 || batchPending) return;
    confirmingBatchDelete = true;
  }

  async function runBatchAction(
    action: 'enable' | 'disable' | 'set_category' | 'delete',
  ) {
    if (selectedIds.length === 0 || batchPending) return;
    confirmingBatchDelete = false;

    batchPending = true;
    try {
      const payload: Record<string, unknown> = {
        feedIds: selectedIds,
        action,
      };
      if (action === 'set_category') {
        payload.category = batchCategory.trim();
      }
      const res = await fetchWithCsrf('/api/feeds/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(result?.error || 'Batch update failed');
      }
      const count = Number(result?.updated ?? selectedIds.length);
      const label =
        action === 'enable'
          ? `Enabled ${count} ${count === 1 ? 'feed' : 'feeds'}`
          : action === 'disable'
            ? `Paused ${count} ${count === 1 ? 'feed' : 'feeds'}`
            : action === 'set_category'
              ? `Updated category for ${count} ${count === 1 ? 'feed' : 'feeds'}`
              : `Deleted ${count} ${count === 1 ? 'feed' : 'feeds'}`;
      addToast(label, 'success');
      clearSelection();
      await refreshAll();
    } catch (error) {
      addToast(
        error instanceof Error ? error.message : 'Batch update failed',
        'error',
      );
    } finally {
      batchPending = false;
    }
  }

  function startCategoryEdit(feed: Feed) {
    editingCategoryFeedId = feed.id;
    editingCategoryValue = feed.category?.trim() || '';
  }

  function cancelCategoryEdit() {
    editingCategoryFeedId = null;
    editingCategoryValue = '';
  }

  async function saveCategoryEdit(feedId: string, event: Event) {
    event.preventDefault();
    if (savingCategory) return;
    savingCategory = true;
    try {
      const res = await fetchWithCsrf(`/api/feeds/${feedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: editingCategoryValue.trim() }),
      });
      const result = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(result?.error || 'Failed to update category');
      }
      addToast('Category updated', 'success');
      cancelCategoryEdit();
      await refreshAll();
    } catch (error) {
      addToast(
        error instanceof Error ? error.message : 'Failed to update category',
        'error',
      );
    } finally {
      savingCategory = false;
    }
  }

  function importOpml() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.opml,.xml';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || importingOpml) return;
      importingOpml = true;
      try {
        const text = await file.text();
        const response = await fetchWithCsrf('/api/opml/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ opml: text }),
        });
        const result = await response.json();
        if (!response.ok) {
          addToast(result.error || 'Could not import OPML.', 'error');
          return;
        }
        const errors = result.errors?.length ?? 0;
        const imported = result.imported
          ? `Imported ${result.imported} feed${result.imported === 1 ? '' : 's'}.`
          : 'No new feeds were imported.';
        if (errors > 0) {
          addToast(
            `${imported} ${result.errors[0]}`,
            result.imported ? 'warning' : 'error',
          );
        } else {
          addToast(imported, result.imported ? 'success' : 'info');
        }
        if (result.imported > 0) await refreshAll();
      } catch {
        addToast('Could not import OPML. Please try again.', 'error');
      } finally {
        importingOpml = false;
      }
    };
    input.click();
  }

  function feedLabel(feed: Feed): string {
    return feed.title?.trim() || new URL(feed.url).hostname;
  }

  function statusLabel(feed: Feed): string {
    switch (feed.health_status) {
      case 'disabled':
        return 'Paused';
      case 'error':
        return 'Needs attention';
      case 'queued':
        return 'Queued';
      case 'fetching':
        return 'Syncing';
      case 'stale':
        return 'Stale';
      case 'never':
        return 'Waiting for first sync';
      case 'healthy':
        return 'Healthy';
      default:
        if (!feed.enabled) return 'Paused';
        if (feed.error_count > 0 || feed.last_fetch_status === 'error')
          return 'Needs attention';
        if (feed.last_fetch_status === 'fetching') return 'Syncing';
        if (feed.health_stale) return 'Stale';
        if (feed.last_fetch_status === 'success') return 'Healthy';
        return 'Waiting for first sync';
    }
  }

  function statusClass(feed: Feed): string {
    switch (feed.health_status) {
      case 'disabled':
        return 'text-surface-300 bg-surface-200/10';
      case 'error':
        return 'text-error-300 bg-error-500/10';
      case 'healthy':
        return 'text-success-300 bg-success-500/10';
      case 'queued':
      case 'fetching':
        return 'text-primary-300 bg-primary-500/10';
      case 'stale':
        return 'text-warning-300 bg-warning-500/10';
      case 'never':
        return 'text-surface-300 bg-white/10';
      default:
        if (!feed.enabled) return 'text-surface-300 bg-surface-200/10';
        if (feed.error_count > 0 || feed.last_fetch_status === 'error') {
          return 'text-error-300 bg-error-500/10';
        }
        if (feed.last_fetch_status === 'fetching')
          return 'text-primary-300 bg-primary-500/10';
        if (feed.health_stale) return 'text-warning-300 bg-warning-500/10';
        if (feed.last_fetch_status === 'success')
          return 'text-success-300 bg-success-500/10';
        return 'text-surface-300 bg-white/10';
    }
  }

  function relativeTime(value?: number | null): string {
    if (!value) return 'Never synced';
    const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000));
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
    return `${Math.floor(minutes / 1440)}d ago`;
  }
</script>

<svelte:head>
  <title>Feeds · Feed Me Maybe</title>
  <meta
    name="description"
    content="Organize your sources, watch feed health, and jump straight into unread stories."
  />
</svelte:head>

<datalist id="feed-categories">
  {#each existingCategories as cat (cat)}
    <option value={cat}></option>
  {/each}
</datalist>

<div class="mx-auto max-w-7xl">
  <div
    class="mb-6 flex flex-col gap-5 md:flex-row md:items-end md:justify-between"
  >
    <div>
      <p class="eyebrow text-primary-300">Manage your feeds</p>
      <h1 class="section-title">Feeds</h1>
      <p
        class="section-subtitle"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {#if query.trim() || statusFilter !== 'all'}
          {filteredFeeds.length} of {data.feeds.length} feeds match · {filteredUnread}
          unread stories.
        {:else}
          {data.feeds.length} feeds · {totalUnread} unread stories.
        {/if}
      </p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="btn preset-filled-primary-500"
        onclick={openAddFeed}>Add feed</button
      >
      <button
        type="button"
        class="btn preset-tonal"
        onclick={importOpml}
        disabled={importingOpml}
        aria-busy={importingOpml}
      >
        {importingOpml ? 'Importing…' : 'Import OPML'}
      </button>
      <a href="/api/opml/export" class="btn preset-tonal no-underline">
        Export OPML
      </a>
      <label class="relative block w-full md:w-72">
        <span class="sr-only">Search feeds</span>
        <svg
          class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-surface-300"
          xmlns="http://www.w3.org/2000/svg"
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          ><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg
        >
        <input
          class="input glass-input w-full pl-10"
          type="search"
          bind:value={query}
          placeholder="Search feeds"
        />
      </label>
    </div>
  </div>

  {#if data.feeds.length > 0}
    <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div
        class="flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Filter feeds by status"
      >
        {#each [{ key: 'all', label: 'All', count: statusCounts.all }, { key: 'active', label: 'Active', count: statusCounts.active }, { key: 'paused', label: 'Paused', count: statusCounts.paused }, { key: 'errored', label: 'Errored', count: statusCounts.errored }] as tab (tab.key)}
          <button
            type="button"
            class="btn px-3 py-1.5 text-xs {statusFilter === tab.key
              ? 'preset-filled-primary-500'
              : 'preset-tonal'}"
            aria-pressed={statusFilter === tab.key}
            onclick={() => (statusFilter = tab.key as StatusFilter)}
          >
            {tab.label} ({tab.count})
          </button>
        {/each}
      </div>

      {#if filteredFeeds.length > 0}
        <button
          type="button"
          class="btn preset-tonal px-3 py-1.5 text-xs"
          onclick={toggleSelectAllFiltered}
        >
          {allFilteredSelected ? 'Deselect shown' : 'Select shown'}
        </button>
      {/if}
    </div>
  {/if}

  {#if selectedIds.length > 0}
    <div
      class="glass-card mb-6 flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between"
      role="region"
      aria-label="Bulk feed actions"
      in:fly={{ y: -8, duration: 180 }}
    >
      <div class="flex items-center gap-3">
        <span class="text-sm font-semibold text-surface-100">
          {selectedIds.length}
          {selectedIds.length === 1 ? 'feed' : 'feeds'} selected
        </span>
        <button
          type="button"
          class="text-xs text-surface-300 underline underline-offset-2 hover:text-surface-100"
          onclick={clearSelection}
          disabled={batchPending}
        >
          Clear
        </button>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="btn preset-tonal px-3 py-1.5 text-xs"
          onclick={() => runBatchAction('enable')}
          disabled={batchPending}
        >
          Enable
        </button>
        <button
          type="button"
          class="btn preset-tonal px-3 py-1.5 text-xs"
          onclick={() => runBatchAction('disable')}
          disabled={batchPending}
        >
          Pause
        </button>
        <form
          class="flex items-center gap-2"
          onsubmit={(event) => {
            event.preventDefault();
            void runBatchAction('set_category');
          }}
        >
          <input
            type="text"
            class="input glass-input w-40 py-1.5 text-xs"
            list="feed-categories"
            bind:value={batchCategory}
            placeholder="Category (empty clears)"
            aria-label="Category for selected feeds"
            disabled={batchPending}
          />
          <button
            type="submit"
            class="btn preset-tonal px-3 py-1.5 text-xs"
            disabled={batchPending}
          >
            Set category
          </button>
        </form>
        <button
          type="button"
          class="btn preset-tonal-error px-3 py-1.5 text-xs"
          onclick={requestBatchDelete}
          disabled={batchPending}
        >
          Delete
        </button>
      </div>
    </div>

    {#if confirmingBatchDelete}
      <div
        class="glass-card mb-6 flex flex-col gap-3 border border-error-500/30 bg-error-500/10 p-4 md:flex-row md:items-center md:justify-between"
        role="alertdialog"
        aria-label="Confirm feed deletion"
      >
        <div class="text-sm text-surface-100">
          <p class="font-semibold">
            Delete {selectedIds.length} selected {selectedIds.length === 1
              ? 'feed'
              : 'feeds'}? All of their articles will be removed.
          </p>
          {#if selectedSavedCount > 0}
            <p class="mt-1 text-xs font-medium text-warning-300">
              Warning: This will permanently delete {selectedSavedCount} saved {selectedSavedCount ===
              1
                ? 'bookmark'
                : 'bookmarks'} stored in {selectedIds.length === 1
                ? 'this feed'
                : 'these feeds'}.
            </p>
          {/if}
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="btn preset-tonal-error px-3 py-1.5 text-xs"
            onclick={() => void runBatchAction('delete')}
            disabled={batchPending}
          >
            Confirm delete
          </button>
          <button
            type="button"
            class="btn preset-tonal px-3 py-1.5 text-xs"
            onclick={() => (confirmingBatchDelete = false)}
            disabled={batchPending}
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}
  {/if}

  {#if data.feeds.length === 0}
    <div class="glass-card p-10 text-center" in:fade={{ duration: 260 }}>
      <p class="text-lg font-semibold text-surface-100">No feeds yet</p>
      <p class="section-subtitle mt-2">Add a feed to start reading.</p>
    </div>
  {:else if groupedFeeds.length === 0}
    <div class="glass-card p-10 text-center" in:fade={{ duration: 260 }}>
      <p class="text-lg font-semibold text-surface-100" role="status">
        No feeds match your current filter.
      </p>
      <button
        class="btn preset-tonal mt-5"
        type="button"
        onclick={() => {
          query = '';
          statusFilter = 'all';
        }}>Clear filters</button
      >
    </div>
  {:else}
    <div class="space-y-10">
      {#each groupedFeeds as [category, feeds], groupIndex (category)}
        <section
          in:fly={{
            y: 10,
            duration: 320,
            delay: Math.min(groupIndex * 45, 240),
          }}
        >
          <div class="mb-3 flex items-center justify-between">
            <div>
              <p class="eyebrow text-surface-300">Category</p>
              <h2 class="text-xl font-semibold text-surface-100">
                {#if feeds.some((feed) => Boolean(feed.category?.trim()))}
                  <a href="/?category={encodeURIComponent(category)}"
                    >{category}</a
                  >
                {:else}
                  {category}
                {/if}
              </h2>
            </div>
            <span class="text-xs uppercase tracking-[0.18em] text-surface-300"
              >{feeds.length} feeds</span
            >
          </div>

          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {#each feeds as feed, index (feed.id)}
              <div
                class="glass-card glass-card-hover group flex min-h-44 flex-col p-4"
                in:fly={{
                  y: 8,
                  duration: 260,
                  delay: Math.min(index * 25, 160),
                }}
              >
                <div class="flex items-start justify-between gap-2">
                  <div class="flex min-w-0 items-start gap-2.5">
                    <input
                      type="checkbox"
                      class="checkbox mt-2 shrink-0"
                      checked={selectedSet.has(feed.id)}
                      onchange={() => toggleSelect(feed.id)}
                      aria-label="Select {feedLabel(feed)}"
                    />
                    <a
                      href="/feeds/{feed.id}"
                      class="flex min-w-0 items-center gap-3 no-underline"
                    >
                      <span
                        class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white/5 ring-1 ring-white/10"
                      >
                        {#if feed.icon_url}
                          <img
                            src={feed.icon_url}
                            alt=""
                            class="h-full w-full object-contain"
                            loading="lazy"
                            decoding="async"
                          />
                        {:else}
                          <span class="text-lg text-primary-300">✦</span>
                        {/if}
                      </span>
                      <div class="min-w-0">
                        <h3
                          class="truncate font-semibold text-surface-100 transition-colors group-hover:text-primary-300"
                        >
                          {feedLabel(feed)}
                        </h3>
                        <p class="truncate text-xs text-surface-300">
                          {new URL(feed.url).hostname}
                        </p>
                      </div>
                    </a>
                  </div>
                  <span
                    class="shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wider {statusClass(
                      feed,
                    )}">{statusLabel(feed)}</span
                  >
                </div>

                <div class="mt-3">
                  {#if editingCategoryFeedId === feed.id}
                    <form
                      class="flex items-center gap-2"
                      onsubmit={(event) =>
                        void saveCategoryEdit(feed.id, event)}
                    >
                      <input
                        type="text"
                        class="input glass-input min-w-0 flex-1 py-1 text-xs"
                        list="feed-categories"
                        bind:value={editingCategoryValue}
                        placeholder="Category (empty for Unsorted)"
                        aria-label="Category for {feedLabel(feed)}"
                        disabled={savingCategory}
                      />
                      <button
                        type="submit"
                        class="btn preset-filled-primary-500 px-2.5 py-1 text-xs"
                        disabled={savingCategory}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        class="btn preset-tonal px-2.5 py-1 text-xs"
                        onclick={cancelCategoryEdit}
                        disabled={savingCategory}
                      >
                        Cancel
                      </button>
                    </form>
                  {:else}
                    <div class="flex items-center justify-between text-xs">
                      <span class="truncate text-surface-300">
                        Category: {feed.category?.trim() ||
                          'Unsorted'}{#if Number(feed.saved_count || 0) > 0}
                          · {feed.saved_count} saved{/if}
                      </span>
                      <button
                        type="button"
                        class="text-primary-300 hover:underline"
                        onclick={() => startCategoryEdit(feed)}
                      >
                        Edit category
                      </button>
                    </div>
                  {/if}
                </div>

                <a
                  href="/feeds/{feed.id}"
                  class="mt-auto grid grid-cols-3 gap-2 border-t border-white/10 pt-4 text-center no-underline"
                >
                  <div>
                    <p class="text-lg font-semibold text-primary-300">
                      {feed.unread_count}
                    </p>
                    <p
                      class="text-[10px] uppercase tracking-wider text-surface-500"
                    >
                      Unread
                    </p>
                  </div>
                  <div>
                    <p class="text-lg font-semibold text-surface-200">
                      {feed.visible_count}
                    </p>
                    <p
                      class="text-[10px] uppercase tracking-wider text-surface-500"
                    >
                      Visible
                    </p>
                  </div>
                  <div>
                    <p class="text-sm font-semibold text-surface-300">
                      {relativeTime(feed.last_fetch_at)}
                    </p>
                    <p
                      class="text-[10px] uppercase tracking-wider text-surface-500"
                    >
                      Updated
                    </p>
                  </div>
                </a>

                {#if feed.last_error}
                  <p class="mt-3 line-clamp-2 text-xs text-error-300">
                    {feed.last_error}
                  </p>
                {/if}
              </div>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {/if}
</div>
