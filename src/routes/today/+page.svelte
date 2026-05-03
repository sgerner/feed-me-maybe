<script lang="ts">
  import { addToast } from '$lib/stores/toast.svelte';
  import { onMount } from 'svelte';
  import { fly, fade } from 'svelte/transition';

  let { data: pageData } = $props();

  let articleIds = $state<string[]>([]);
  let focusedIndex = $state(0);

  function timeAgo(date: number | null): string {
    if (!date) return '';
    const seconds = Math.floor((Date.now() - date) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(date).toLocaleDateString();
  }

  async function interact(articleId: string, type: string) {
    try {
      const res = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleId, type })
      });
      if (res.ok) {
        const labels: Record<string, string> = { hide: 'Hidden', save: 'Saved', thumbs_up: 'Liked', thumbs_down: 'Disliked' };
        addToast(labels[type] || type, 'success');
        if (type === 'hide') {
          window.location.reload();
        }
      }
    } catch { addToast('Action failed', 'error'); }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      focusedIndex = Math.min(focusedIndex + 1, articleIds.length - 1);
      document.getElementById(`article-${articleIds[focusedIndex]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      focusedIndex = Math.max(focusedIndex - 1, 0);
      document.getElementById(`article-${articleIds[focusedIndex]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      if (articleIds[focusedIndex]) window.location.href = `/articles/${articleIds[focusedIndex]}`;
    }
    if (e.key === 'h') {
      e.preventDefault();
      if (articleIds[focusedIndex]) interact(articleIds[focusedIndex], 'hide');
    }
    if (e.key === 's') {
      e.preventDefault();
      if (articleIds[focusedIndex]) interact(articleIds[focusedIndex], 'save');
    }
  }

  onMount(() => {
    articleIds = pageData.articles.map((a: { id: string }) => a.id);
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  });

  let touchStartX = 0;
  let touchStartY = 0;

  function handleTouchStart(e: TouchEvent) {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
  }

  function handleTouchEnd(e: TouchEvent, articleId: string) {
    const dx = e.changedTouches[0].screenX - touchStartX;
    const dy = e.changedTouches[0].screenY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 80) {
      if (dx < 0) interact(articleId, 'hide');
      else interact(articleId, 'save');
    }
  }
</script>

<div class="mx-auto max-w-7xl">
  <div class="mb-8">
    <h1 class="section-title">Today</h1>
    <p class="section-subtitle">{pageData.totalArticles} articles waiting for you</p>
  </div>

  {#if pageData.articles.length === 0}
    <div class="glass-card mt-16 p-8 text-center" in:fade={{ duration: 300 }}>
      <div class="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full" style="background: color-mix(in oklch, var(--color-primary-500) 10%, transparent);">
        <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-primary-400">
          <path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>
        </svg>
      </div>
      <p class="text-surface-300 mb-2 text-lg font-medium">No articles yet</p>
      <p class="section-subtitle mb-6">Add some RSS feeds to get started.</p>
      <a href="/feeds" class="btn preset-filled-primary-500 inline-flex items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Feeds
      </a>
    </div>
  {:else}
    <div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {#each pageData.articles as article, i (article.id)}
        <div
          id="article-{article.id}"
          class="glass-card glass-card-hover p-4 md:p-5"
          class:article-focus-ring={focusedIndex === i}
          role="listitem"
          in:fly={{ y: 16, duration: 350, delay: Math.min(i * 35, 400) }}
          ontouchstart={handleTouchStart}
          ontouchend={(e) => handleTouchEnd(e, article.id)}
        >
          <div class="flex gap-4">
            {#if article.image_url}
              <img src={article.image_url} alt="" class="mt-1 h-20 w-20 flex-shrink-0 object-cover shadow-md md:h-24 md:w-24" style="border-radius: 2px;" loading="lazy" />
            {/if}
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2 text-xs" style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);">
                <span class="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium" style="background: color-mix(in oklch, var(--color-primary-500) 10%, transparent); color: var(--color-primary-300); border-radius: 2px;">
                  {article.feed_title || 'Unknown'}
                </span>
                <span class="flex items-center gap-1">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  {timeAgo(article.published_at || article.fetched_at)}
                </span>
              </div>
              <a href="/articles/{article.id}" class="mt-1.5 block text-base font-semibold leading-snug no-underline transition-colors hover:text-primary-400 md:text-lg" style="color: var(--color-surface-50);">
                {article.title}
              </a>
              {#if article.summary}
                <p class="mt-1.5 line-clamp-2 text-sm leading-relaxed" style="color: color-mix(in oklch, var(--color-surface-200) 60%, transparent);">{article.summary}</p>
              {/if}
              <div class="mt-3 flex items-center gap-1.5">
                <button type="button" class="action-btn" onclick={() => interact(article.id, 'hide')} title="Hide (h)">
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                  Hide
                </button>
                <button type="button" class="action-btn" onclick={() => interact(article.id, 'save')} title="Save (s)">
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
                  Save
                </button>
                <button type="button" class="action-btn" onclick={() => interact(article.id, 'thumbs_up')} title="Like">
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"/></svg>
                </button>
                <button type="button" class="action-btn" onclick={() => interact(article.id, 'thumbs_down')} title="Dislike">
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      {/each}
    </div>

    <!-- Pagination -->
    {#if pageData.totalPages > 1}
      <div class="mt-8 flex items-center justify-center gap-4">
        {#if pageData.page > 1}
          <a href="/today?page={pageData.page - 1}" class="action-btn gap-1.5 px-3 py-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
            Previous
          </a>
        {/if}
        <span class="text-sm font-medium" style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);">Page {pageData.page} of {pageData.totalPages}</span>
        {#if pageData.page < pageData.totalPages}
          <a href="/today?page={pageData.page + 1}" class="action-btn gap-1.5 px-3 py-2">
            Next
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
          </a>
        {/if}
      </div>
    {/if}
  {/if}
</div>