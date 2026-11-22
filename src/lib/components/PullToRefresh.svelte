<script lang="ts">
  import type { Snippet } from 'svelte';
  import { addToast } from '#lib/stores/toast.svelte.ts';

  let {
    onSync,
    syncing,
    mobileOnly = false,
    children,
  }: {
    onSync: () => Promise<void>;
    syncing: boolean;
    mobileOnly?: boolean;
    children: Snippet;
  } = $props();

  let pullDistance = $state(0);
  let isPulling = $state(false);
  let syncAnnouncement = $state('');
  let touchStartY = 0;
  let touchStartedAtTop = false;

  function isAtTop() {
    return (document.querySelector('main')?.scrollTop ?? 0) <= 0;
  }

  async function sync() {
    syncAnnouncement = 'Syncing feeds.';
    try {
      await onSync();
      syncAnnouncement = 'Feed sync finished.';
    } catch {
      syncAnnouncement = 'Feed sync failed.';
      addToast('Sync failed', 'error');
    }
  }

  function handleTouchStart(e: TouchEvent) {
    if (
      mobileOnly &&
      typeof window !== 'undefined' &&
      window.matchMedia('(min-width: 768px)').matches
    ) {
      touchStartedAtTop = false;
      isPulling = false;
      pullDistance = 0;
      return;
    }
    touchStartedAtTop = isAtTop();
    touchStartY = e.changedTouches[0].screenY;
    isPulling = false;
    pullDistance = 0;
  }

  function handleTouchMove(e: TouchEvent) {
    if (!touchStartedAtTop || !isAtTop()) {
      if (isPulling || pullDistance > 0) resetPull();
      return;
    }

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
      void sync();
    }
    resetPull();
  }

  function resetPull() {
    pullDistance = 0;
    isPulling = false;
    touchStartedAtTop = false;
  }
</script>

<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
  {syncAnnouncement}
</p>

<div
  class="mx-auto max-w-7xl"
  role="presentation"
  style="overscroll-behavior-y: contain; touch-action: pan-y;"
  ontouchstart={handleTouchStart}
  ontouchmove={handleTouchMove}
  ontouchend={handleTouchEnd}
  ontouchcancel={resetPull}
>
  <div
    class={'flex justify-center overflow-hidden transition-all duration-200' +
      (mobileOnly ? ' md:hidden' : '')}
    aria-hidden="true"
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
        {syncing
          ? 'Syncing...'
          : pullDistance >= 60
            ? 'Release to sync'
            : 'Pull to sync'}
      </span>
    </div>
  </div>

  {@render children()}
</div>
