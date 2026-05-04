<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import { navigating } from '$app/state';
  import { subscribeToasts, type Toast } from '$lib/stores/toast.svelte';
  import { fade, fly } from 'svelte/transition';
  import { invalidateAll } from '$app/navigation';
  import PWABanner from '$lib/components/PWABanner.svelte';
  import KeyboardShortcuts from '$lib/components/KeyboardShortcuts.svelte';

  let sidebarOpen = $state(false);
  let showShortcuts = $state(false);
  let syncing = $state(false);
  let addingFeed = $state(false);
  let showAddFeedModal = $state(false);
  let newFeedUrl = $state('');
  let toasts = $state<Toast[]>([]);
  let { children, data } = $props();

  async function syncFeeds() {
    if (syncing) return;
    syncing = true;
    try {
      const res = await fetch('/api/feeds/refresh', { method: 'POST' });
      if (res.ok) {
        const { addToast } = await import('$lib/stores/toast.svelte');
        addToast('Syncing feeds in background', 'success');
      }
    } catch {
      const { addToast } = await import('$lib/stores/toast.svelte');
      addToast('Sync failed', 'error');
    } finally {
      syncing = false;
    }
  }

  async function addFeed(e: Event) {
    e.preventDefault();
    if (!newFeedUrl.trim() || addingFeed) return;

    addingFeed = true;
    try {
      const res = await fetch('/api/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: newFeedUrl.trim() }),
      });
      if (res.ok) {
        newFeedUrl = '';
        showAddFeedModal = false;
        const { addToast } = await import('$lib/stores/toast.svelte');
        addToast('Feed added successfully', 'success');
        // Refresh the page to show the new feed in the sidebar
        await invalidateAll();
      } else {
        const errData = await res.json();
        const { addToast } = await import('$lib/stores/toast.svelte');
        addToast(errData.error || 'Failed to add feed', 'error');
      }
    } catch {
      const { addToast } = await import('$lib/stores/toast.svelte');
      addToast('Failed to add feed', 'error');
    } finally {
      addingFeed = false;
    }
  }

  const navItems = [
    {
      href: '/',
      label: 'All Feeds',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>',
    },
    {
      href: '/saved',
      label: 'Saved',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>',
    },
  ];

  const adminItems = [
    {
      href: '/settings',
      label: 'Settings',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
    },
  ];

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
  }

  $effect(() => {
    if ($page.url.pathname) {
      sidebarOpen = false;
    }
  });

  $effect(() => {
    const unsubscribe = subscribeToasts((value) => {
      toasts = value;
    });

    return unsubscribe;
  });

  // Real-time updates via SSE
  $effect(() => {
    if (!data.sessionId) return;

    let eventSource: EventSource;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    function connect() {
      eventSource = new EventSource('/api/events');

      eventSource.addEventListener('new_articles', async (event) => {
        try {
          const payload = JSON.parse(event.data);
          console.log('[sse] New articles received:', payload);

          // Refresh the page data
          await invalidateAll();

          const { addToast } = await import('$lib/stores/toast.svelte');
          addToast(`Synced ${payload.count} new articles`, 'info');
        } catch (err) {
          console.error('[sse] Error handling new_articles event:', err);
        }
      });

      eventSource.onerror = (err) => {
        console.error('[sse] EventSource error, reconnecting...', err);
        eventSource.close();
        reconnectTimeout = setTimeout(connect, 5000);
      };
    }

    connect();

    return () => {
      if (eventSource) eventSource.close();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    };
  });
</script>

<!-- Cinematic Background -->
<div class="cinematic-bg" aria-hidden="true">
  <div class="cinematic-bg-orb cinematic-bg-orb-1"></div>
  <div class="cinematic-bg-orb cinematic-bg-orb-2"></div>
  <div class="cinematic-bg-orb cinematic-bg-orb-3"></div>
</div>
<div class="grain-overlay" aria-hidden="true"></div>
<div class="vignette" aria-hidden="true"></div>

<div class="relative z-10 flex h-dvh flex-col">
  <!-- Top Navigation Bar (Mobile only) -->
  <header
    class="glass-header flex h-14 shrink-0 items-center justify-between px-4 md:hidden"
  >
    <div class="flex items-center gap-3">
      <button
        class="btn-icon"
        onclick={toggleSidebar}
        aria-label="Toggle navigation"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <a
        href="/"
        data-sveltekit-preload-data
        class="gradient-text text-lg font-bold no-underline"
      >
        Feed Me Maybe
      </a>
    </div>

    <button
      class="btn-icon"
      onclick={() => (showShortcuts = true)}
      aria-label="Keyboard shortcuts"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><rect width="18" height="12" x="3" y="6" rx="2" ry="2" /><path
          d="M7 10h.01"
        /><path d="M11 10h.01" /><path d="M15 10h.01" /><path
          d="M17 10h.01"
        /><path d="M7 14h.01" /><path d="M11 14h.01" /><path
          d="M15 14h.01"
        /><path d="M17 14h.01" /></svg
      >
    </button>
  </header>

  <div class="flex flex-1 overflow-hidden">
    <!-- Sidebar overlay (mobile) -->
    {#if sidebarOpen}
      <div
        class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
        onclick={toggleSidebar}
        role="presentation"
      ></div>
    {/if}

    <!-- Sidebar -->
    <aside
      class="glass-sidebar fixed left-0 top-14 z-50 h-[calc(100dvh-3.5rem)] w-56 transform transition-transform duration-300 ease-out md:static md:top-0 md:h-dvh md:translate-x-0"
      class:translate-x-0={sidebarOpen}
      class:-translate-x-full={!sidebarOpen}
    >
      <div class="hidden p-2 md:block">
        <a
          href="/"
          data-sveltekit-preload-data
          class="gradient-text text-xl font-bold no-underline"
        >
          Feed Me Maybe
        </a>
      </div>

      <div
        class="flex h-[calc(100%-5rem)] flex-col justify-between p-3 md:h-[calc(100%-4rem)]"
      >
        <nav class="flex flex-col gap-1 overflow-y-auto">
          {#each navItems as item (item.href)}
            <a
              href={item.href}
              data-sveltekit-preload-data
              class={'nav-item' +
                ($page.url.pathname === item.href ? ' nav-item-active' : '')}
            >
              <span class="flex h-5 w-5 items-center justify-center"
                >{@html item.icon}</span
              >
              <span>{item.label}</span>
            </a>
          {/each}

          {#if data.feeds && data.feeds.length > 0}
            <div class="mt-4 flex items-center justify-between px-3 pb-2">
              <div
                class="text-[10px] font-bold uppercase tracking-widest"
                style="color: color-mix(in oklch, var(--color-surface-200) 30%, transparent);"
              >
                Your Feeds
              </div>
              <button
                class="flex h-5 w-5 items-center justify-center rounded-full bg-white/5 transition-colors hover:bg-white/10"
                onclick={() => (showAddFeedModal = true)}
                aria-label="Add feed"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  ><line x1="12" y1="5" x2="12" y2="19" /><line
                    x1="5"
                    y1="12"
                    x2="19"
                    y2="12"
                  /></svg
                >
              </button>
            </div>
            {#each data.feeds as feed (feed.id)}
              <a
                href="/feeds/{feed.id}"
                data-sveltekit-preload-data
                class={'nav-item' +
                  ($page.url.pathname === `/feeds/${feed.id}`
                    ? ' nav-item-active'
                    : '')}
              >
                <span
                  class="flex h-5 w-5 items-center justify-center overflow-hidden rounded-sm bg-white/5"
                >
                  {#if feed.icon_url}
                    <img
                      src={feed.icon_url}
                      alt=""
                      class="h-full w-full object-contain"
                    />
                  {:else}
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      style="color: color-mix(in oklch, var(--color-surface-200) 40%, transparent);"
                      ><path d="M4 11a9 9 0 0 1 9 9" /><path
                        d="M4 4a16 16 0 0 1 16 16"
                      /><circle cx="5" cy="19" r="1" /></svg
                    >
                  {/if}
                </span>
                <span class="truncate">{feed.title || 'Untitled'}</span>
              </a>
            {/each}
          {/if}

          <button
            class="nav-item mt-4 hidden w-full items-center gap-3 bg-transparent text-left md:flex"
            onclick={syncFeeds}
            disabled={syncing}
          >
            <span class="flex h-5 w-5 items-center justify-center">
              {#if syncing}
                <div
                  class="h-4 w-4 animate-spin rounded-full border-2 border-primary-500 border-t-transparent"
                ></div>
              {:else}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  ><path
                    d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"
                  /><path d="M3 3v5h5" /><path
                    d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"
                  /><path d="M16 16h5v5" /></svg
                >
              {/if}
            </span>
            <span>{syncing ? 'Syncing...' : 'Sync Feeds'}</span>
          </button>
        </nav>

        <nav
          class="mt-auto flex flex-col gap-1 border-t pt-4"
          style="border-color: color-mix(in oklch, var(--color-surface-100) 5%, transparent);"
        >
          {#each adminItems as item (item.href)}
            <a
              href={item.href}
              data-sveltekit-preload-data
              class={'nav-item' +
                ($page.url.pathname.startsWith(item.href)
                  ? ' nav-item-active'
                  : '')}
            >
              <span class="flex h-5 w-5 items-center justify-center"
                >{@html item.icon}</span
              >
              <span>{item.label}</span>
            </a>
          {/each}

          <button
            class="nav-item bg-transparent text-left"
            onclick={() => (showShortcuts = true)}
          >
            <span class="flex h-5 w-5 items-center justify-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                ><rect width="18" height="12" x="3" y="6" rx="2" ry="2" /><path
                  d="M7 10h.01"
                /><path d="M11 10h.01" /><path d="M15 10h.01" /><path
                  d="M17 10h.01"
                /><path d="M7 14h.01" /><path d="M11 14h.01" /><path
                  d="M15 14h.01"
                /><path d="M17 14h.01" /></svg
              >
            </span>
            <span>Keyboard Shortcuts</span>
          </button>
        </nav>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="relative flex-1 overflow-auto md:p-8">
      {#key $page.url.pathname}
        {@render children()}
      {/key}
    </main>
  </div>

  {#if navigating.to?.url?.searchParams?.get('mode') === 'archive'}
    <div
      class="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-surface-950/80 backdrop-blur-sm"
      transition:fade={{ duration: 200 }}
    >
      <div
        class="h-8 w-8 animate-spin rounded-full border-4 border-primary-500 border-t-transparent"
      ></div>
      <p class="text-sm font-medium text-surface-200">
        Loading from Archive...
      </p>
      <p class="max-w-xs text-center text-xs text-surface-400">
        This may take a few moments as we retrieve the archived version.
      </p>
    </div>
  {/if}

  <!-- Toast container -->
  <div class="fixed bottom-5 right-5 z-50 flex flex-col gap-2.5">
    {#each toasts as toast (toast.id)}
      <div
        in:fly={{ y: 12, duration: 280, delay: 60 }}
        out:fly={{ y: 8, duration: 200 }}
        class="toast-glass rounded-[2px] px-4 py-2.5 text-sm font-medium text-white shadow-xl transition-all duration-300"
        class:toast-success={toast.type === 'success'}
        class:toast-error={toast.type === 'error'}
        class:toast-info={toast.type === 'info'}
        class:toast-warning={toast.type === 'warning'}
      >
        {toast.message}
      </div>
    {/each}
  </div>

  {#if showAddFeedModal}
    <div
      class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-md"
      transition:fade={{ duration: 200 }}
      onclick={() => (showAddFeedModal = false)}
      role="presentation"
    >
      <div
        class="glass-card w-full max-w-md p-6 shadow-2xl"
        transition:fly={{ y: 20, duration: 300 }}
        onclick={(e) => e.stopPropagation()}
        role="presentation"
      >
        <div class="mb-4 flex items-center justify-between">
          <h3 class="text-lg font-bold">Add New Feed</h3>
          <button
            class="btn-icon"
            onclick={() => (showAddFeedModal = false)}
            aria-label="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg
            >
          </button>
        </div>

        <form onsubmit={addFeed} class="space-y-4">
          <label class="label">
            <span class="mb-1 block text-sm font-medium">Feed URL</span>
            <input
              type="url"
              bind:value={newFeedUrl}
              placeholder="https://example.com/rss"
              class="input glass-input w-full"
              required
              disabled={addingFeed}
            />
          </label>

          <div class="flex justify-end gap-3 pt-2">
            <button
              type="button"
              class="btn preset-tonal"
              onclick={() => (showAddFeedModal = false)}
              disabled={addingFeed}
            >
              Cancel
            </button>
            <button
              type="submit"
              class="btn preset-filled-primary-500 flex items-center gap-2"
              disabled={addingFeed || !newFeedUrl.trim()}
            >
              {#if addingFeed}
                <svg
                  class="h-4 w-4 animate-spin"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    class="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    stroke-width="4"
                  ></circle>
                  <path
                    class="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                Adding...
              {:else}
                Add Feed
              {/if}
            </button>
          </div>
        </form>
      </div>
    </div>
  {/if}

  <PWABanner />
  <KeyboardShortcuts bind:open={showShortcuts} />
</div>
