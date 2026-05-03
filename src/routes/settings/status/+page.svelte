<script lang="ts">
  let { data: pageData } = $props();
</script>

<h2 class="section-title text-lg">System Status</h2>
<p class="section-subtitle">Overview of your RSS reader instance.</p>

<div class="mt-8 grid grid-cols-3 gap-4">
  <div class="stat-card">
    <p class="stat-value">{pageData.feedCount}</p>
    <p class="mt-1 text-xs font-medium" style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);">Feeds</p>
  </div>
  <div class="stat-card">
    <p class="stat-value">{pageData.articleCount}</p>
    <p class="mt-1 text-xs font-medium" style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);">Articles</p>
  </div>
  <div class="stat-card">
    <p class="stat-value">{pageData.jobCount}</p>
    <p class="mt-1 text-xs font-medium" style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);">Pending Jobs</p>
  </div>
</div>

{#if pageData.recentJobs?.length > 0}
  <h3 class="mb-3 mt-8 flex items-center gap-2 text-sm font-semibold" style="color: var(--color-surface-100);">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
    Recent Fetches
  </h3>
  <div class="space-y-2">
    {#each pageData.recentJobs as job}
      <div class="glass-card flex items-center gap-3 p-3 text-xs">
        <span class="inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium" style={job.status === 'success' ? 'background: color-mix(in oklch, var(--color-success-500) 12%, transparent); color: var(--color-success-300);' : 'background: color-mix(in oklch, var(--color-warning-500) 12%, transparent); color: var(--color-warning-300);'}>
          {#if job.status === 'success'}
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          {/if}
          {job.status}
        </span>
        <span style="color: var(--color-surface-100);">{new Date(job.created_at).toLocaleString()}</span>
        <span style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);">{job.articles_found || 0} found, {job.articles_new || 0} new</span>
      </div>
    {/each}
  </div>
{/if}