<script lang="ts">
  let { data: pageData } = $props();

  const article = $derived(pageData.article);
</script>

<div class="mx-auto max-w-3xl">
  <a href="/today" class="mb-6 inline-flex items-center gap-1.5 text-sm no-underline transition-colors hover:text-primary-400" style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);">
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>
    Back to Today
  </a>

  <article class="glass-card glass-card-hover overflow-hidden">
    {#if article.image_url}
      <div class="relative">
        <img src={article.image_url} alt="" class="h-64 w-full object-cover md:h-80" loading="lazy" />
        <div class="absolute inset-0 bg-gradient-to-t from-[var(--color-surface-950)] via-transparent to-transparent opacity-80"></div>
      </div>
    {/if}

    <div class="p-5 md:p-8">
      <div class="mb-6">
        <div class="flex flex-wrap items-center gap-2 text-xs" style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);">
          <span class="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-medium" style="background: color-mix(in oklch, var(--color-primary-500) 10%, transparent); color: var(--color-primary-300);">
            {article.feed_title || 'Unknown Feed'}
          </span>
          {#if article.author}
            <span class="flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              {article.author}
            </span>
          {/if}
          <span class="flex items-center gap-1">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            {article.published_at ? new Date(article.published_at).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : ''}
          </span>
          {#if article.feed_site_url}
            <a href={article.feed_site_url} class="flex items-center gap-1 underline transition-colors hover:text-primary-400" target="_blank" rel="noopener">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              Visit Source
            </a>
          {/if}
        </div>
        <h1 class="mt-3 text-2xl font-bold leading-tight md:text-3xl" style="color: var(--color-surface-50);">{article.title}</h1>
      </div>

      {#if article.ai_summary}
        <div class="mb-6 rounded-xl border p-5" style="background: color-mix(in oklch, var(--color-secondary-500) 6%, transparent); border-color: color-mix(in oklch, var(--color-secondary-500) 15%, transparent);">
          <div class="mb-2 flex items-center gap-2 text-sm font-semibold" style="color: var(--color-secondary-300);">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/><path d="M11 17v.01"/><path d="M7 14v.01"/></svg>
            AI Summary
          </div>
          <p class="text-sm leading-relaxed" style="color: color-mix(in oklch, var(--color-surface-100) 75%, transparent);">{article.ai_summary}</p>
        </div>
      {/if}

      {#if article.explanation}
        <details class="mb-6 rounded-xl border p-4" style="background: color-mix(in oklch, var(--color-surface-100) 3%, transparent); border-color: color-mix(in oklch, var(--color-surface-100) 8%, transparent);">
          <summary class="flex cursor-pointer items-center gap-2 text-sm font-medium" style="color: color-mix(in oklch, var(--color-surface-200) 70%, transparent);">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            Why this article?
          </summary>
          <p class="mt-3 text-sm leading-relaxed" style="color: color-mix(in oklch, var(--color-surface-200) 55%, transparent);">{article.explanation}</p>
        </details>
      {/if}

      <div class="prose prose-sm max-w-none prose-glass">
        {#if article.content}
          {@html article.content}
        {:else if article.summary}
          <p class="leading-relaxed">{article.summary}</p>
        {:else}
          <p class="italic" style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);">No content available.</p>
        {/if}
      </div>

      <div class="mt-8 flex flex-wrap items-center gap-2 border-t pt-5" style="border-color: color-mix(in oklch, var(--color-surface-100) 8%, transparent);">
        <a href={article.url} target="_blank" rel="noopener noreferrer" class="btn preset-filled-primary-500 inline-flex items-center gap-2 text-sm">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          Open Original
        </a>
        <button class="action-btn px-3 py-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
          Save
        </button>
        <button class="action-btn px-3 py-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
          Hide
        </button>
      </div>
    </div>
  </article>
</div>