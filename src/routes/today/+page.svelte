<script lang="ts">
  import { addToast } from '$lib/stores/toast.svelte';
  import ArticleList from '$lib/components/ArticleList.svelte';

  let { data: pageData } = $props();

  let articles = $state<any[]>(pageData.articles);
  let pullDistance = $state(0);
  let isPulling = $state(false);
  let syncing = $state(false);

  async function syncFeeds() {
    if (syncing) return;
    syncing = true;
    try {
      const res = await fetch('/api/feeds/refresh', { method: 'POST' });
      if (res.ok) {
        addToast('Syncing feeds in background', 'success');
      }
    } catch {
      addToast('Sync failed', 'error');
    } finally {
      syncing = false;
    }
  }

  function handleTouchStart(e: TouchEvent) {
    if (window.scrollY <= 0) {
      isPulling = true;
      // We don't need to track startY here for the child component, 
      // but we need it for our pull-to-refresh logic.
      touchStartY = e.changedTouches[0].screenY;
    }
  }

  let touchStartY = 0;

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
      syncFeeds();
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

  <ArticleList 
    bind:articles={articles} 
    totalPages={pageData.totalPages} 
  />
</div>