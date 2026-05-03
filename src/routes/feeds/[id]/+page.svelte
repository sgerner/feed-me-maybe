<script lang="ts">
  import { addToast } from '$lib/stores/toast.svelte';
  import ArticleList from '$lib/components/ArticleList.svelte';
  import { fly, fade } from 'svelte/transition';

  let { data: pageData } = $props();

  let articles = $state<any[]>(pageData.articles);
  let feed = $state(pageData.feed);
  let showSettings = $state(false);
  let saving = $state(false);
  let saveSuccess = $state(false);

  // Settings form state
  let title = $state(String(pageData.feed.title ?? ''));
  let category = $state(String(pageData.feed.category ?? ''));
  let enabled = $state(!!pageData.feed.enabled);

  let pullDistance = $state(0);
  let isPulling = $state(false);
  let syncing = $state(false);
  let touchStartY = 0;

  async function syncFeed() {
    if (syncing) return;
    syncing = true;
    try {
      const res = await fetch(`/api/feeds/${pageData.feedId}/refresh`, { method: 'POST' });
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
        body: JSON.stringify({ title, category, enabled })
      });
      if (res.ok) {
        saveSuccess = true;
        feed.title = title;
        setTimeout(() => { saveSuccess = false; }, 2000);
      } else {
        throw new Error();
      }
    } catch {
      addToast('Failed to save settings', 'error');
    } finally {
      saving = false;
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

  function handleTouchEnd(e: TouchEvent) {
    if (isPulling && pullDistance >= 60) {
      syncFeed();
    }
    pullDistance = 0;
    isPulling = false;
  }
</script>

<div
  class="mx-auto max-w-7xl"
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
      <h1 class="section-title">{feed.title || 'Untitled Feed'}</h1>
      {#if !feed.enabled}
        <span class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider" style="background: color-mix(in oklch, var(--color-warning-500) 12%, transparent); color: var(--color-warning-300); border-radius: 2px;">Disabled</span>
      {/if}
    </div>
    <button 
      class="btn preset-filled-surface-200-800 flex items-center gap-2"
      onclick={() => showSettings = !showSettings}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
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
          <input class="input glass-input" type="text" bind:value={category} placeholder="e.g., Technology, News" />
        </label>
        <label class="flex items-center gap-3">
          <input type="checkbox" bind:checked={enabled} class="checkbox" />
          <span class="text-sm">Feed enabled</span>
        </label>
      </div>
      <div class="mt-6 flex items-center gap-4">
        <button class="btn preset-filled-primary-500" onclick={saveSettings} disabled={saving}>
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
        {#if saveSuccess}
          <span class="text-sm text-success-400" in:fade>Settings saved!</span>
        {/if}
      </div>
    </div>
  {/if}

  <ArticleList 
    bind:articles={articles} 
    totalPages={pageData.totalPages} 
    feedId={pageData.feedId} 
  />
</div>