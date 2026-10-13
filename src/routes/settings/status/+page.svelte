<script lang="ts">
  import { fly } from 'svelte/transition';
  type RecentJob = {
    status: string;
    created_at: number;
    articles_found?: number | null;
    articles_new?: number | null;
  };

  type RecentError = {
    source: string;
    message: string;
    path?: string | null;
    method?: string | null;
    details?: Record<string, unknown>;
    created_at: number;
  };

  let { data: pageData } = $props<{
    data: {
      jev?: {
        configured: boolean;
        activeProvider?: 'jev' | 'subq';
        activeProviderConfigured?: boolean;
        subqConfigured?: boolean;
        scored: number;
        missing: number | null;
        jobs: Array<{ status: string; count: number }>;
        recentJobs: Array<{
          id: string;
          status: string;
          attempts: number;
          max_attempts: number;
          scheduled_at: number | null;
          error_message: string | null;
        }>;
      };
      feedCount?: number;
      articleCount?: number;
      jobCount?: number;
      recentJobs?: RecentJob[];
      recentErrors?: RecentError[];
    };
  }>();
</script>

<h2 class="section-title text-lg">System Status</h2>
<p class="section-subtitle">Overview of your RSS reader instance.</p>

<div class="mt-8 grid grid-cols-3 gap-4">
  <div class="stat-card" in:fly={{ y: 12, duration: 300 }}>
    <p class="stat-value">{pageData.feedCount}</p>
    <p
      class="mt-1 text-xs font-medium"
      style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);"
    >
      Feeds
    </p>
  </div>
  <div class="stat-card" in:fly={{ y: 12, duration: 300, delay: 60 }}>
    <p class="stat-value">{pageData.articleCount}</p>
    <p
      class="mt-1 text-xs font-medium"
      style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);"
    >
      Articles
    </p>
  </div>
  <div class="stat-card" in:fly={{ y: 12, duration: 300, delay: 120 }}>
    <p class="stat-value">{pageData.jobCount}</p>
    <p
      class="mt-1 text-xs font-medium"
      style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);"
    >
      Pending Jobs
    </p>
  </div>
</div>

{#if pageData.jev}
  <h3 class="mb-3 mt-8 text-sm font-semibold">Article Ranking</h3>
  <div class="glass-card space-y-2 p-3 text-xs">
    {#if pageData.jev.activeProvider}
      <p>
        Selected provider: {pageData.jev.activeProvider === 'subq'
          ? 'SubQ Snap'
          : 'Jev'} · {pageData.jev.activeProviderConfigured
          ? 'configured'
          : 'API key missing'}
      </p>
      <p>
        Jev key: {pageData.jev.configured ? 'configured' : 'missing'} · SubQ key:
        {pageData.jev.subqConfigured ? 'configured' : 'missing'}
      </p>
    {/if}
    <p>
      {pageData.jev.activeProvider
        ? pageData.jev.activeProviderConfigured
          ? 'Active provider ready'
          : 'Paused: active provider API key not configured'
        : pageData.jev.configured
          ? 'Configured'
          : 'Paused: API key not configured'} · {pageData.jev.scored} scored · {pageData
        .jev.missing ?? 0} missing scores
    </p>
    <p>
      {#each pageData.jev.jobs as group}
        <span class="mr-3">{group.count} {group.status}</span>
      {/each}
    </p>
    <p>
      Missing scores are backfilled gradually. Failed jobs stop after their
      retry budget is exhausted.
    </p>
    {#each pageData.jev.recentJobs as job (job.id)}
      <div class="border-t border-white/10 pt-2">
        <p>
          {job.status} · attempt {job.attempts}/{job.max_attempts}{#if job.status === 'queued' && job.scheduled_at}
            · scheduled {new Date(job.scheduled_at).toLocaleString()}{/if}
        </p>
        {#if job.error_message}<p>{job.error_message}</p>{/if}
      </div>
    {/each}
  </div>
{/if}

{#if (pageData.recentJobs ?? []).length > 0}
  <h3
    class="mb-3 mt-8 flex items-center gap-2 text-sm font-semibold"
    style="color: var(--color-surface-100);"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      ><path
        d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"
      /><polyline points="14 2 14 8 20 8" /></svg
    >
    Recent Fetches
  </h3>
  <div class="space-y-2">
    {#each pageData.recentJobs ?? [] as job, i}
      <div
        class="glass-card flex items-center gap-3 p-3 text-xs"
        in:fly={{ y: 8, duration: 250, delay: Math.min(i * 40, 300) }}
      >
        <span
          class="inline-flex items-center gap-1 px-2 py-0.5 font-medium"
          style={job.status === 'success'
            ? 'background: color-mix(in oklch, var(--color-success-500) 12%, transparent); color: var(--color-success-300); border-radius: 2px;'
            : 'background: color-mix(in oklch, var(--color-warning-500) 12%, transparent); color: var(--color-warning-300); border-radius: 2px;'}
        >
          {#if job.status === 'success'}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"><path d="M20 6 9 17l-5-5" /></svg
            >
          {:else}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
              ><circle cx="12" cy="12" r="10" /><line
                x1="12"
                y1="8"
                x2="12"
                y2="12"
              /><line x1="12" y1="16" x2="12.01" y2="16" /></svg
            >
          {/if}
          {job.status}
        </span>
        <span style="color: var(--color-surface-100);"
          >{new Date(job.created_at).toLocaleString()}</span
        >
        <span
          style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);"
          >{job.articles_found || 0} found, {job.articles_new || 0} new</span
        >
      </div>
    {/each}
  </div>
{/if}

{#if (pageData.recentErrors ?? []).length > 0}
  <h3
    class="mb-3 mt-8 flex items-center gap-2 text-sm font-semibold"
    style="color: var(--color-surface-100);"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      ><path
        d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
      /></svg
    >
    Recent Errors
  </h3>
  <div class="space-y-2">
    {#each pageData.recentErrors ?? [] as errorRow, i}
      <div
        class="glass-card flex flex-col gap-2 p-3 text-xs"
        in:fly={{ y: 8, duration: 250, delay: Math.min(i * 40, 300) }}
      >
        <div class="flex flex-wrap items-center gap-2">
          <span
            class="inline-flex items-center gap-1 px-2 py-0.5 font-medium"
            style="background: color-mix(in oklch, var(--color-error-500) 12%, transparent); color: var(--color-error-300); border-radius: 2px;"
          >
            {errorRow.source}
          </span>
          <span style="color: var(--color-surface-100);"
            >{new Date(errorRow.created_at).toLocaleString()}</span
          >
          {#if errorRow.method}
            <span
              style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);"
              >{errorRow.method}</span
            >
          {/if}
          {#if errorRow.path}
            <span
              style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);"
              >{errorRow.path}</span
            >
          {/if}
        </div>
        <div
          style="color: color-mix(in oklch, var(--color-surface-100) 82%, transparent);"
        >
          {errorRow.message}
        </div>
        {#if errorRow.details && Object.keys(errorRow.details).length > 0}
          <pre
            class="overflow-x-auto rounded-sm p-2 text-[11px]"
            style="background: color-mix(in oklch, var(--color-surface-800) 30%, transparent); color: color-mix(in oklch, var(--color-surface-200) 70%, transparent);">{JSON.stringify(
              errorRow.details,
              null,
              2,
            )}</pre>
        {/if}
      </div>
    {/each}
  </div>
{/if}
