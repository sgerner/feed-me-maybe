<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';

  let feed = $state<Record<string, unknown> | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let title = $state('');
  let category = $state('');
  let enabled = $state(true);
  let saveSuccess = $state(false);

  async function loadFeed() {
    loading = true;
    try {
      const res = await fetch(`/api/feeds/${$page.params.id}`);
      if (!res.ok) throw new Error('Not found');
      const data = await res.json();
      feed = data.feed;
      title = String(data.feed.title ?? '');
      category = String(data.feed.category ?? '');
      enabled = !!data.feed.enabled;
    } catch {
      error = 'Feed not found';
    } finally {
      loading = false;
    }
  }

  async function save() {
    saving = true;
    saveSuccess = false;
    try {
      const res = await fetch(`/api/feeds/${$page.params.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, category, enabled })
      });
      if (!res.ok) throw new Error('Save failed');
      saveSuccess = true;
      setTimeout(() => { saveSuccess = false; }, 2000);
    } catch {
      error = 'Failed to save feed';
    } finally {
      saving = false;
    }
  }

  async function refreshFeed() {
    const res = await fetch(`/api/feeds/${$page.params.id}/refresh`, { method: 'POST' });
    if (res.ok) await loadFeed();
  }

  async function removeFeed() {
    if (!confirm('Delete this feed and all its articles?')) return;
    const res = await fetch(`/api/feeds/${$page.params.id}`, { method: 'DELETE' });
    if (res.ok) goto('/feeds');
  }

  $effect(() => { loadFeed(); });
</script>

<div class="mx-auto max-w-2xl">
  <a href="/feeds" class="mb-6 inline-flex items-center gap-1.5 text-sm no-underline transition-colors hover:text-primary-400" style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);">
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
    Back to Feeds
  </a>

  {#if loading}
    <div class="glass-card h-40 animate-pulse p-5"></div>
  {:else if error}
    <div class="glass-card flex items-center gap-2 p-4 text-sm" style="background: color-mix(in oklch, var(--color-error-500) 8%, transparent); color: var(--color-error-300); border-color: color-mix(in oklch, var(--color-error-500) 18%, transparent);">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      {error}
    </div>
  {:else if feed}
    <div class="glass-card glass-card-hover p-5 md:p-8">
      <h1 class="text-xl font-bold md:text-2xl" style="color: var(--color-surface-50);">{feed.title || 'Untitled Feed'}</h1>
      <p class="mt-1 break-all text-sm" style="color: color-mix(in oklch, var(--color-surface-200) 40%, transparent);">{feed.url}</p>

      {#if saveSuccess}
        <div class="mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm" style="background: color-mix(in oklch, var(--color-success-500) 10%, transparent); color: var(--color-success-300); border: 1px solid color-mix(in oklch, var(--color-success-500) 20%, transparent);">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
          Saved successfully!
        </div>
      {/if}

      <div class="mt-6 space-y-4">
        <label class="label">
          <span class="mb-1 block text-sm font-medium" style="color: var(--color-surface-100);">Title</span>
          <input class="input glass-input" type="text" bind:value={title} />
        </label>
        <label class="label">
          <span class="mb-1 block text-sm font-medium" style="color: var(--color-surface-100);">Category</span>
          <input class="input glass-input" type="text" bind:value={category} placeholder="e.g., Technology, News" />
        </label>
        <label class="flex items-center gap-3">
          <input type="checkbox" bind:checked={enabled} class="checkbox" />
          <span class="text-sm" style="color: var(--color-surface-100);">Feed enabled</span>
        </label>
      </div>

      <div class="mt-6 flex flex-wrap gap-2">
        <button class="btn preset-filled-primary-500 inline-flex items-center gap-2" disabled={saving} onclick={save}>
          {#if saving}
            <svg class="animate-spin" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            Saving...
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            Save
          {/if}
        </button>
        <button class="action-btn px-3 py-2" onclick={refreshFeed}>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>
          Refresh Now
        </button>
        <button class="action-btn px-3 py-2 text-error-300" style="border-color: color-mix(in oklch, var(--color-error-500) 15%, transparent);" onclick={removeFeed}>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
          Delete
        </button>
      </div>

      <!-- Feed Info -->
      <div class="mt-8 border-t pt-5" style="border-color: color-mix(in oklch, var(--color-surface-100) 6%, transparent);">
        <h3 class="mb-3 flex items-center gap-2 text-sm font-semibold" style="color: var(--color-surface-100);">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          Feed Info
        </h3>
        <dl class="space-y-2 text-xs">
          <div class="flex gap-2">
            <dt class="w-24 font-medium" style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);">Status:</dt>
            <dd class="flex items-center gap-1.5" style="color: var(--color-surface-100);">
              {#if feed.last_fetch_status === 'success'}
                <span class="status-dot" style="background: var(--color-success-500); color: var(--color-success-500);"></span>
              {:else if feed.last_fetch_status === 'error'}
                <span class="status-dot" style="background: var(--color-error-500); color: var(--color-error-500);"></span>
              {:else}
                <span class="status-dot" style="background: color-mix(in oklch, var(--color-surface-200) 30%, transparent);"></span>
              {/if}
              {feed.last_fetch_status || 'never'}
            </dd>
          </div>
          <div class="flex gap-2">
            <dt class="w-24 font-medium" style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);">Last fetch:</dt>
            <dd style="color: var(--color-surface-100);">{feed.last_fetch_at ? new Date(Number(feed.last_fetch_at)).toLocaleString() : 'Never'}</dd>
          </div>
          {#if feed.last_error}
            <div class="flex gap-2">
              <dt class="w-24 font-medium" style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);">Last error:</dt>
              <dd class="text-error-300">{feed.last_error}</dd>
            </div>
          {/if}
          <div class="flex gap-2">
            <dt class="w-24 font-medium" style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);">Created:</dt>
            <dd style="color: var(--color-surface-100);">{new Date(Number(feed.created_at)).toLocaleDateString()}</dd>
          </div>
        </dl>
      </div>
    </div>
  {/if}
</div>