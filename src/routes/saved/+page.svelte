<script lang="ts">
  let { data: pageData } = $props();
  async function unsave(articleId: string) {
    await fetch('/api/interactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ articleId, type: 'unsave' }) });
    window.location.reload();
  }
</script>
<div class="mx-auto max-w-2xl">
  <div class="mb-8">
    <h1 class="section-title">Saved</h1>
    <p class="section-subtitle">{pageData.articles.length} saved articles</p>
  </div>
  {#if pageData.articles.length === 0}
    <div class="glass-card mt-16 p-8 text-center">
      <div class="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full" style="background: color-mix(in oklch, var(--color-secondary-500) 10%, transparent);">
        <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--color-secondary-400);">
          <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>
        </svg>
      </div>
      <p class="text-surface-300 mb-1 text-lg font-medium">No saved articles yet</p>
      <p class="section-subtitle">Save articles from your Today feed to read later.</p>
    </div>
  {:else}
    <div class="space-y-3">
      {#each pageData.articles as article (article.id)}
        <div class="glass-card glass-card-hover flex items-start justify-between p-4 md:p-5">
          <div class="min-w-0 flex-1">
            <span class="mb-1 inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium" style="background: color-mix(in oklch, var(--color-primary-500) 10%, transparent); color: var(--color-primary-300);">{article.feed_title}</span>
            <a href="/articles/{article.id}" class="block font-semibold no-underline transition-colors hover:text-primary-400" style="color: var(--color-surface-50);">{article.title}</a>
          </div>
          <button class="action-btn ml-3 flex-shrink-0" onclick={() => unsave(article.id)}>
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
            Unsave
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>