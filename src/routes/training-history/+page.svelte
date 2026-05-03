<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  let { data: pageData } = $props();
  async function unhide(articleId: string) {
    await fetch('/api/interactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ articleId, type: 'unhide' }) });
    window.location.reload();
  }
</script>
<div class="mx-auto max-w-7xl">
  <div class="mb-8">
    <h1 class="section-title">Training History</h1>
    <p class="section-subtitle">Articles you've hidden — used to train your preferences.</p>
  </div>
  {#if pageData.articles.length === 0}
    <div class="glass-card mt-16 p-8 text-center" in:fade={{ duration: 300 }}>
      <div class="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full" style="background: color-mix(in oklch, var(--color-tertiary-500) 10%, transparent);">
        <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--color-tertiary-400);">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <p class="text-surface-300 mb-1 text-lg font-medium">No hidden articles yet</p>
      <p class="section-subtitle">Hide articles you don't like to improve recommendations.</p>
    </div>
  {:else}
    <div class="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {#each pageData.articles as a, i (a.id)}
        <div class="glass-card glass-card-hover flex items-center justify-between p-4" in:fly={{ y: 14, duration: 320, delay: Math.min(i * 35, 350) }}>
          <div class="min-w-0 flex-1">
            <span class="mb-1 inline-flex items-center px-2 py-0.5 text-xs font-medium" style="background: color-mix(in oklch, var(--color-primary-500) 10%, transparent); color: var(--color-primary-300); border-radius: 2px;">{a.feed_title}</span>
            <p class="mt-0.5 truncate text-sm font-medium" style="color: var(--color-surface-50);">{a.title}</p>
          </div>
          <button class="action-btn ml-2 flex-shrink-0" onclick={() => unhide(a.id)}>
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7"/><path d="M17 21v-8"/><path d="M7 21v-8"/><path d="M7 3v5h10V3"/></svg>
            Unhide
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>