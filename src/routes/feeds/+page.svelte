<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  let feeds = $state<Array<Record<string, unknown>>>([]);
  let loading = $state(true);
  let error = $state('');
  let newUrl = $state('');
  let newTitle = $state('');
  let newCategory = $state('');
  let adding = $state(false);
  let addError = $state('');

  async function loadFeeds() {
    loading = true;
    error = '';
    try {
      const res = await fetch('/api/feeds');
      if (!res.ok) throw new Error('Failed to load feeds');
      const data = await res.json();
      feeds = data.feeds;
    } catch {
      error = 'Could not load feeds.';
    } finally {
      loading = false;
    }
  }

  async function addFeed() {
    if (!newUrl.trim()) return;
    adding = true;
    addError = '';
    try {
      const res = await fetch('/api/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: newUrl.trim(), title: newTitle.trim(), category: newCategory.trim() })
      });
      if (!res.ok) {
        const data = await res.json();
        addError = data.error || 'Failed to add feed';
        return;
      }
      newUrl = '';
      newTitle = '';
      newCategory = '';
      await loadFeeds();
    } catch {
      addError = 'Connection error';
    } finally {
      adding = false;
    }
  }

  async function deleteFeed(id: string) {
    if (!confirm('Delete this feed and all its articles?')) return;
    try {
      const res = await fetch(`/api/feeds/${id}`, { method: 'DELETE' });
      if (res.ok) await loadFeeds();
    } catch {
      // ignore
    }
  }

  $effect(() => { loadFeeds(); });
</script>

<div class="mx-auto max-w-3xl">
  <div class="mb-8">
    <h1 class="section-title">Feeds</h1>
    <p class="section-subtitle">Manage your RSS/Atom feed sources.</p>
  </div>

  <!-- Add Feed Form -->
  <div class="glass-card glass-card-hover mb-6 p-5" in:fly={{ y: 12, duration: 300 }}>
    <h2 class="mb-4 flex items-center gap-2 text-sm font-semibold" style="color: var(--color-surface-100);">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Add Feed
    </h2>
    <div class="flex flex-col gap-3">
      <input class="input glass-input" type="url" bind:value={newUrl} placeholder="Feed URL (e.g., https://example.com/rss)" required />
      <div class="flex gap-3">
        <input class="input glass-input flex-1" type="text" bind:value={newTitle} placeholder="Title (optional)" />
        <input class="input glass-input flex-1" type="text" bind:value={newCategory} placeholder="Category (optional)" />
      </div>
      {#if addError}
        <div class="flex items-center gap-2 px-3 py-2 text-sm" style="background: color-mix(in oklch, var(--color-error-500) 10%, transparent); color: var(--color-error-300); border: 1px solid color-mix(in oklch, var(--color-error-500) 20%, transparent); border-radius: 2px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          {addError}
        </div>
      {/if}
      <button class="btn preset-filled-primary-500 inline-flex items-center justify-center gap-2" disabled={adding || !newUrl.trim()} onclick={addFeed}>
        {#if adding}
          <svg class="animate-spin" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        {/if}
        {adding ? 'Adding...' : 'Add Feed'}
      </button>
    </div>
  </div>

  <!-- Feed List -->
  {#if loading}
    <div class="mt-6 space-y-3">
      {#each [1,2,3] as _, i (i)}
        <div class="glass-card h-24 animate-pulse p-5"></div>
      {/each}
    </div>
  {:else if error}
    <div class="glass-card mt-6 flex items-center gap-2 p-4 text-sm" style="background: color-mix(in oklch, var(--color-warning-500) 8%, transparent); color: var(--color-warning-300); border-color: color-mix(in oklch, var(--color-warning-500) 18%, transparent);">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      {error}
    </div>
  {:else if feeds.length === 0}
    <div class="glass-card mt-12 p-8 text-center" in:fade={{ duration: 300 }}>
      <div class="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full" style="background: color-mix(in oklch, var(--color-primary-500) 10%, transparent);">
        <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-primary-400">
          <path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>
        </svg>
      </div>
      <p class="text-surface-300 mb-1 text-lg font-medium">No feeds yet</p>
      <p class="section-subtitle">Add one above to get started.</p>
    </div>
  {:else}
    <div class="mt-6 space-y-3">
      {#each feeds as feed, i (feed.id)}
        <div class="glass-card glass-card-hover flex items-center justify-between p-4 md:p-5" in:fly={{ y: 12, duration: 300, delay: Math.min(i * 30, 300) }}>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <a href="/feeds/{feed.id}" class="font-semibold no-underline transition-colors hover:text-primary-400" style="color: var(--color-surface-50);">{feed.title || feed.url}</a>
              {#if !feed.enabled}
                <span class="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider" style="background: color-mix(in oklch, var(--color-warning-500) 12%, transparent); color: var(--color-warning-300); border-radius: 2px;">Disabled</span>
              {/if}
            </div>
            <p class="mt-0.5 truncate text-xs" style="color: color-mix(in oklch, var(--color-surface-200) 40%, transparent);">{feed.url}</p>
            <div class="mt-2 flex flex-wrap items-center gap-2 text-xs" style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);">
              {#if feed.category}
                <span class="inline-flex items-center px-1.5 py-0.5" style="background: color-mix(in oklch, var(--color-surface-100) 6%, transparent); border-radius: 2px;">{feed.category}</span>
              {/if}
              <span class="flex items-center gap-1">
                {#if feed.last_fetch_status === 'success'}
                  <span class="status-dot" style="background: var(--color-success-500); color: var(--color-success-500);"></span>
                {:else if feed.last_fetch_status === 'error'}
                  <span class="status-dot" style="background: var(--color-error-500); color: var(--color-error-500);"></span>
                {:else}
                  <span class="status-dot" style="background: color-mix(in oklch, var(--color-surface-200) 30%, transparent); color: color-mix(in oklch, var(--color-surface-200) 30%, transparent);"></span>
                {/if}
                {feed.last_fetch_status || 'never fetched'}
              </span>
              {#if feed.last_fetch_at}
                <span class="flex items-center gap-1">
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  {new Date(Number(feed.last_fetch_at)).toLocaleDateString()}
                </span>
              {/if}
            </div>
          </div>
          <div class="ml-3 flex items-center gap-2">
            <a href="/feeds/{feed.id}" class="action-btn px-2.5 py-1.5" aria-label="Edit feed">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
            </a>
            <button class="action-btn px-2.5 py-1.5 hover:text-error-300" style="--hover-bg: color-mix(in oklch, var(--color-error-500) 12%, transparent);" aria-label="Delete feed" onclick={() => deleteFeed(String(feed.id))}>
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>