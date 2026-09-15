<script lang="ts">
  import { fade, fly } from 'svelte/transition';

  type Feed = {
    id: string;
    url: string;
    title?: string | null;
    category?: string | null;
    icon_url?: string | null;
    enabled: boolean | number;
    error_count: number;
    last_fetch_status?: string | null;
    last_fetch_at?: number | null;
    last_error?: string | null;
    poll_interval_mins?: number | null;
    unread_count: number;
    visible_count: number;
    article_count: number;
  };

  let { data }: { data: { feeds: Feed[] } } = $props();
  let query = $state('');

  const filteredFeeds = $derived(
    data.feeds.filter((feed) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return [feed.title, feed.url, feed.category]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    }),
  );

  const groupedFeeds = $derived.by(() => {
    const groups = new Map<string, Feed[]>();
    for (const feed of filteredFeeds) {
      const name = feed.category?.trim() || 'Unsorted';
      const group = groups.get(name) || [];
      group.push(feed);
      groups.set(name, group);
    }
    return [...groups.entries()];
  });

  const totalUnread = $derived(
    data.feeds.reduce((sum, feed) => sum + Number(feed.unread_count || 0), 0),
  );

  function feedLabel(feed: Feed): string {
    return feed.title?.trim() || new URL(feed.url).hostname;
  }

  function statusLabel(feed: Feed): string {
    if (!feed.enabled) return 'Paused';
    if (feed.error_count > 0 || feed.last_fetch_status === 'error')
      return 'Needs attention';
    if (feed.last_fetch_status === 'success') return 'Healthy';
    return 'Waiting for first sync';
  }

  function statusClass(feed: Feed): string {
    if (!feed.enabled) return 'text-surface-400 bg-surface-200/10';
    if (feed.error_count > 0 || feed.last_fetch_status === 'error') {
      return 'text-error-300 bg-error-500/10';
    }
    if (feed.last_fetch_status === 'success')
      return 'text-success-300 bg-success-500/10';
    return 'text-warning-300 bg-warning-500/10';
  }

  function relativeTime(value?: number | null): string {
    if (!value) return 'Never synced';
    const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000));
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
    return `${Math.floor(minutes / 1440)}d ago`;
  }
</script>

<svelte:head>
  <title>Feeds · Feed Me Maybe</title>
  <meta
    name="description"
    content="Organize your sources, watch feed health, and jump straight into unread stories."
  />
</svelte:head>

<div class="mx-auto max-w-7xl">
  <div
    class="mb-8 flex flex-col gap-5 md:flex-row md:items-end md:justify-between"
  >
    <div>
      <p class="eyebrow text-primary-300">Manage your feeds</p>
      <h1 class="section-title">Feeds</h1>
      <p class="section-subtitle">
        {data.feeds.length} feeds · {totalUnread} unread stories.
      </p>
    </div>
    <label class="relative block w-full md:w-80">
      <span class="sr-only">Search feeds</span>
      <svg
        class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-surface-400"
        xmlns="http://www.w3.org/2000/svg"
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        ><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg
      >
      <input
        class="input glass-input w-full pl-10"
        type="search"
        bind:value={query}
        placeholder="Search feeds"
      />
    </label>
  </div>

  {#if data.feeds.length === 0}
    <div class="glass-card p-10 text-center" in:fade={{ duration: 260 }}>
      <p class="text-lg font-semibold text-surface-100">No feeds yet</p>
      <p class="section-subtitle mt-2">Add a feed to start reading.</p>
    </div>
  {:else if groupedFeeds.length === 0}
    <div class="glass-card p-10 text-center" in:fade={{ duration: 260 }}>
      <p class="text-lg font-semibold text-surface-100">
        No feeds match “{query}”.
      </p>
      <button
        class="btn preset-tonal mt-5"
        type="button"
        onclick={() => (query = '')}>Clear search</button
      >
    </div>
  {:else}
    <div class="space-y-10">
      {#each groupedFeeds as [category, feeds], groupIndex (category)}
        <section
          in:fly={{
            y: 10,
            duration: 320,
            delay: Math.min(groupIndex * 45, 240),
          }}
        >
          <div class="mb-3 flex items-center justify-between">
            <div>
              <p class="eyebrow text-surface-400">Category</p>
              <h2 class="text-xl font-semibold text-surface-100">{category}</h2>
            </div>
            <span class="text-xs uppercase tracking-[0.18em] text-surface-400"
              >{feeds.length} feeds</span
            >
          </div>

          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {#each feeds as feed, index (feed.id)}
              <a
                href="/feeds/{feed.id}"
                class="glass-card glass-card-hover group flex min-h-44 flex-col p-4 no-underline"
                in:fly={{
                  y: 8,
                  duration: 260,
                  delay: Math.min(index * 25, 160),
                }}
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="flex min-w-0 items-center gap-3">
                    <span
                      class="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white/5 ring-1 ring-white/10"
                    >
                      {#if feed.icon_url}
                        <img
                          src={feed.icon_url}
                          alt=""
                          class="h-full w-full object-contain"
                          loading="lazy"
                          decoding="async"
                        />
                      {:else}
                        <span class="text-lg text-primary-300">✦</span>
                      {/if}
                    </span>
                    <div class="min-w-0">
                      <h3
                        class="truncate font-semibold text-surface-100 transition-colors group-hover:text-primary-300"
                      >
                        {feedLabel(feed)}
                      </h3>
                      <p class="truncate text-xs text-surface-400">
                        {new URL(feed.url).hostname}
                      </p>
                    </div>
                  </div>
                  <span
                    class="shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wider {statusClass(
                      feed,
                    )}">{statusLabel(feed)}</span
                  >
                </div>

                <div
                  class="mt-auto grid grid-cols-3 gap-2 border-t border-white/10 pt-4 text-center"
                >
                  <div>
                    <p class="text-lg font-semibold text-primary-300">
                      {feed.unread_count}
                    </p>
                    <p
                      class="text-[10px] uppercase tracking-wider text-surface-500"
                    >
                      Unread
                    </p>
                  </div>
                  <div>
                    <p class="text-lg font-semibold text-surface-200">
                      {feed.visible_count}
                    </p>
                    <p
                      class="text-[10px] uppercase tracking-wider text-surface-500"
                    >
                      Visible
                    </p>
                  </div>
                  <div>
                    <p class="text-sm font-semibold text-surface-300">
                      {relativeTime(feed.last_fetch_at)}
                    </p>
                    <p
                      class="text-[10px] uppercase tracking-wider text-surface-500"
                    >
                      Updated
                    </p>
                  </div>
                </div>

                {#if feed.last_error}
                  <p class="mt-3 line-clamp-2 text-xs text-error-300">
                    {feed.last_error}
                  </p>
                {/if}
              </a>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {/if}
</div>
