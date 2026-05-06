<script lang="ts">
  import { addToast } from '$lib/stores/toast.svelte';
  import ArticleList from '$lib/components/ArticleList.svelte';

  import { syncFeeds } from '$lib/feeds';

  type Article = {
    id: string;
    url: string;
    title: string;
    feed_open_mode?: string | null;
  };

  let { data: pageData } = $props<{
    data: { articles: Article[]; totalPages: number };
  }>();

  let articles = $state<Article[]>([]);
  let pullDistance = $state(0);
  let isPulling = $state(false);
  let syncing = $state(false);
  let touchStartY = 0;

  $effect(() => {
    articles = pageData.articles;
  });

  function getScrollContainer(): HTMLElement | null {
    return document.querySelector('main');
  }

  function isAtTop(): boolean {
    const container = getScrollContainer();
    return !container || container.scrollTop <= 0;
  }

  async function handleSync() {
    if (syncing) return;
    syncing = true;
    try {
      await syncFeeds();
    } finally {
      syncing = false;
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
      <span class="text-xs font-bold uppercase tracking-wider">
        {syncing ? 'Syncing...' : pullDistance >= 60 ? 'Release to sync' : 'Pull to sync'}
      </span>
    </div>
  </div>

  <ArticleList bind:articles totalPages={pageData.totalPages} />
</div>
