<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import { navigating } from '$app/state';
  import {
    addToast,
    subscribeToasts,
    type Toast,
  } from '$lib/stores/toast.svelte';
  import { fade, fly } from 'svelte/transition';
  import { invalidateAll } from '$app/navigation';
  import PWABanner from '$lib/components/PWABanner.svelte';
  import KeyboardShortcuts from '$lib/components/KeyboardShortcuts.svelte';

  import { syncFeeds } from '$lib/feeds';
  import { fetchWithCsrf } from '$lib/client/csrf';
  import {
    activateOfflineUser,
    clearOfflinePrivateData,
    getOfflineSyncStatus,
    installOfflineSync,
  } from '$lib/offline';

  let sidebarOpen = $state(false);
  let showShortcuts = $state(false);
  let syncing = $state(false);
  let offlineState = $state<
    'online' | 'offline' | 'queued' | 'blocked' | 'syncing'
  >('online');
  let queuedActions = $state(0);
  let syncNeedsAttention = $state(false);
  let addingFeed = $state(false);
  let showAddFeedModal = $state(false);
  let newFeedUrl = $state('');
  let addFeedDialogEl = $state<HTMLDivElement | null>(null);
  let addFeedPreviouslyFocused: HTMLElement | null = null;
  let toasts = $state<Toast[]>([]);
  let stopOfflineSync: (() => void) | null = null;
  let { children, data } = $props();

  function applyOfflineStatus(pendingCount: number, blocked = false) {
    queuedActions = pendingCount;
    syncNeedsAttention = blocked;

    if (syncing) {
      offlineState = 'syncing';
    } else if (blocked) {
      offlineState = 'blocked';
    } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      offlineState = 'offline';
    } else if (pendingCount > 0) {
      offlineState = 'queued';
    } else {
      offlineState = 'online';
    }
  }

  async function refreshOfflineStatus(scope: string) {
    if (typeof window === 'undefined') return;

    try {
      const status = await getOfflineSyncStatus(scope);
      applyOfflineStatus(
        status.pendingCount,
        status.state === 'blocked' || Boolean(status.lastError),
      );
    } catch {
      applyOfflineStatus(0);
    }
  }

  async function handleManualSync() {
    if (syncing) return;
    syncing = true;
    offlineState = 'syncing';
    try {
      await syncFeeds();
    } finally {
      syncing = false;
      void refreshOfflineStatus(String(data.userId || 'admin'));
    }
  }

  // Trigger sync on open and visibility change
  $effect(() => {
    if (!data.sessionId) return;

    // Let the shell paint before starting the background refresh. This keeps
    // startup responsive and avoids waking the radio when the app is hidden.
    const initialSyncTimeout =
      document.visibilityState === 'visible'
        ? window.setTimeout(() => {
            void syncFeeds({ silent: true });
          }, 450)
        : null;

    // Sync on visibility change (re-opening the tab/app)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncFeeds({ silent: true });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      if (initialSyncTimeout !== null) {
        window.clearTimeout(initialSyncTimeout);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });

  async function addFeed(e: Event) {
    e.preventDefault();
    if (!newFeedUrl.trim() || addingFeed) return;

    addingFeed = true;
    try {
      const res = await fetchWithCsrf('/api/feeds', {
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

  async function logout() {
    stopOfflineSync?.();
    stopOfflineSync = null;
    await fetch('/api/logout', { method: 'POST' }).catch(() => undefined);
    await clearOfflinePrivateData().catch(() => undefined);
    window.location.assign('/login');
  }

  // Start the small, account-scoped outbox only after the shell is painted.
  // It sleeps while offline/hidden and wakes on an explicit online event or
  // Background Sync, keeping the PWA responsive and battery-conscious.
  $effect(() => {
    if (typeof window === 'undefined' || !data.sessionId) return;

    const scope = String(data.userId || 'admin');
    let disposed = false;
    void activateOfflineUser(scope)
      .then(() => {
        if (disposed) return;
        stopOfflineSync = installOfflineSync(scope, {
          onReplay: (result) => {
            applyOfflineStatus(
              result.remaining,
              result.blocked > 0 || result.conflicts > 0,
            );
            if (result.synced > 0) {
              addToast(
                `${result.synced} offline action${result.synced === 1 ? '' : 's'} synced`,
                'success',
              );
            }
            if (result.blocked > 0 || result.conflicts > 0) {
              addToast('An offline action needs your attention', 'error');
            }
          },
        });
      })
      .catch((error) => console.debug('Offline sync unavailable', error));

    return () => {
      disposed = true;
      stopOfflineSync?.();
      stopOfflineSync = null;
    };
  });

  // Keep the shell's small status indicator in sync with the existing local
  // outbox and browser connection without adding a network request.
  $effect(() => {
    if (typeof window === 'undefined' || !data.sessionId) return;

    const scope = String(data.userId || 'admin');
    const refresh = () => void refreshOfflineStatus(scope);
    const handleOffline = () => {
      offlineState = 'offline';
      refresh();
    };

    window.addEventListener('online', refresh);
    window.addEventListener('offline', handleOffline);
    const statusInterval = window.setInterval(refresh, 15_000);
    refresh();

    return () => {
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', handleOffline);
      window.clearInterval(statusInterval);
    };
  });

  $effect(() => {
    if (!showAddFeedModal) return;

    addFeedPreviouslyFocused = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => addFeedDialogEl?.focus());
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        showAddFeedModal = false;
      }
    };
    document.addEventListener('keydown', handleKeydown);

    return () => {
      document.removeEventListener('keydown', handleKeydown);
      addFeedPreviouslyFocused?.focus?.();
      addFeedPreviouslyFocused = null;
    };
  });

  const navItems = [
    {
      href: '/',
      label: 'All',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>',
    },
    {
      href: '/inbox',
      label: 'Unread',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v14H4z"/><path d="M4 14h4l2 3h4l2-3h4"/><path d="M8 8h8"/></svg>',
    },
    {
      href: '/search',
      label: 'Search',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
    },
    {
      href: '/saved',
      label: 'Saved',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>',
    },
    {
      href: '/digest',
      label: 'Briefing',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><path d="M8 2v4"/><path d="M16 2v4"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/></svg>',
    },
    {
      href: '/feeds',
      label: 'Feeds',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M8 7h8M8 11h8M8 15h5"/></svg>',
    },
  ];

  const mobileCoreItems = navItems.filter((item) =>
    ['/', '/inbox', '/search', '/saved'].includes(item.href),
  );

  const adminItems = [
    {
      href: '/settings',
      label: 'Settings',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
    },
  ];

  let secondaryOpen = $state(false);

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
  }

  function openMore() {
    secondaryOpen = true;
    sidebarOpen = true;
  }

  $effect(() => {
    if ($page.url.pathname) {
      sidebarOpen = false;
    }
  });

  $effect(() => {
    const path = $page.url.pathname;
    if (path.startsWith('/recovery') || path.startsWith('/settings')) {
      secondaryOpen = true;
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

    type NetworkInformation = { saveData?: boolean };
    type NavigatorWithConnection = Navigator & {
      connection?: NetworkInformation;
    };

    let eventSource: EventSource | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let disposed = false;
    const reconnectBaseMs = 5000;
    const reconnectMaxMs = 60_000;

    function canUseLiveUpdates() {
      const connection = (navigator as NavigatorWithConnection).connection;
      return (
        document.visibilityState === 'visible' &&
        navigator.onLine !== false &&
        connection?.saveData !== true
      );
    }

    function clearReconnect() {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
    }

    function closeConnection() {
      clearReconnect();
      eventSource?.close();
      eventSource = null;
    }

    function scheduleReconnect() {
      if (disposed || !canUseLiveUpdates() || reconnectTimeout) return;

      const exponentialDelay = Math.min(
        reconnectBaseMs * 2 ** reconnectAttempt,
        reconnectMaxMs,
      );
      const jitter = Math.round(exponentialDelay * (0.1 + Math.random() * 0.2));
      reconnectAttempt = Math.min(reconnectAttempt + 1, 4);
      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        connect();
      }, exponentialDelay + jitter);
    }

    function connect() {
      if (disposed || eventSource || !canUseLiveUpdates()) return;

      eventSource = new EventSource('/api/events');

      eventSource.onopen = () => {
        reconnectAttempt = 0;
      };

      eventSource.addEventListener('new_articles', async (event) => {
        try {
          const payload = JSON.parse(event.data);

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
        closeConnection();
        scheduleReconnect();
      };
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        reconnectAttempt = 0;
        connect();
      } else {
        closeConnection();
      }
    };
    const handleOnline = () => connect();
    const handleOffline = closeConnection;

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    connect();

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      closeConnection();
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
  <div class="flex flex-1 overflow-hidden">
    <!-- Sidebar overlay (mobile) -->
    {#if sidebarOpen}
      <div
        class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
        onclick={toggleSidebar}
        onkeydown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleSidebar();
          }
        }}
        role="button"
        tabindex="0"
        aria-label="Close navigation"
      ></div>
    {/if}

    <!-- Sidebar -->
    <aside
      id="app-sidebar"
      class="glass-sidebar fixed left-0 top-0 z-50 h-dvh w-56 transform transition-transform duration-300 ease-out max-md:pt-[env(safe-area-inset-top)] md:static md:top-0 md:h-dvh md:translate-x-0"
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
        <nav class="flex flex-col gap-1 overflow-y-auto" aria-label="Primary">
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
              <span class="min-w-0 flex-1 truncate">{item.label}</span>
              {#if item.href === '/inbox' && data.counts?.unread}
                <span
                  class="rounded-full bg-primary-500/15 px-1.5 py-0.5 text-[10px] font-bold text-primary-300"
                  >{data.counts.unread}</span
                >
              {/if}
            </a>
          {/each}

          {#if data.feeds && data.feeds.length > 0}
            <div class="mt-4 flex items-center justify-between px-3 pb-1">
              <div
                class="text-[10px] font-bold uppercase tracking-widest"
                style="color: color-mix(in oklch, var(--color-surface-200) 30%, transparent);"
              >
                Sources
              </div>
              <button
                class="nav-icon-button"
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
            <details
              class="nav-feed-group"
              open={$page.url.pathname.startsWith('/feeds/')}
            >
              <summary class="nav-feed-summary">
                <span>Browse sources</span>
                <span class="text-[10px] text-surface-400"
                  >{data.feeds.length}</span
                >
              </summary>
              <div class="mt-1 flex flex-col gap-1">
                {#each data.feeds as feed (feed.id)}
                  <a
                    href="/feeds/{feed.id}"
                    data-sveltekit-preload-data
                    class={'nav-item nav-item-subtle' +
                      ($page.url.pathname === `/feeds/${feed.id}`
                        ? ' nav-item-active'
                        : '')}
                  >
                    <span
                      class="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-white/5"
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
                    <span class="min-w-0 flex-1 truncate"
                      >{feed.title || 'Untitled'}</span
                    >
                    {#if feed.unread_count}
                      <span
                        class="rounded-full bg-primary-500/15 px-1.5 py-0.5 text-[10px] font-bold text-primary-300"
                        >{feed.unread_count}</span
                      >
                    {/if}
                  </a>
                {/each}
              </div>
            </details>
          {/if}

          <button
            class="nav-item mt-4 hidden w-full items-center gap-3 bg-transparent text-left md:flex"
            onclick={handleManualSync}
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
            <span>{syncing ? 'Syncing...' : 'Sync now'}</span>
          </button>
        </nav>

        <nav
          class="mt-auto flex flex-col gap-1 border-t pt-3"
          style="border-color: color-mix(in oklch, var(--color-surface-100) 5%, transparent);"
          aria-label="More"
        >
          <button
            class="nav-section-toggle"
            onclick={() => (secondaryOpen = !secondaryOpen)}
            aria-expanded={secondaryOpen}
            aria-controls="secondary-navigation"
          >
            <span class="flex items-center gap-3">
              <span
                class="flex h-5 w-5 items-center justify-center text-surface-400"
              >
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
                  ><circle cx="5" cy="12" r="1" /><circle
                    cx="12"
                    cy="12"
                    r="1"
                  /><circle cx="19" cy="12" r="1" /></svg
                >
              </span>
              <span>More</span>
            </span>
            <svg
              class="nav-section-chevron"
              class:nav-section-chevron-open={secondaryOpen}
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg
            >
          </button>

          {#if secondaryOpen}
            <div id="secondary-navigation" class="flex flex-col gap-1">
              <a
                href="/recovery"
                data-sveltekit-preload-data
                class={'nav-item' +
                  ($page.url.pathname.startsWith('/recovery')
                    ? ' nav-item-active'
                    : '')}
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
                    ><path d="M3 12a9 9 0 1 0 3-6.7" /><path
                      d="M3 4v8h8"
                    /><path d="M12 8v4l3 2" /></svg
                  >
                </span>
                <span class="min-w-0 flex-1 truncate"
                  >Review hidden &amp; rejected</span
                >
              </a>
            </div>
          {/if}
          {#if secondaryOpen}
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
                  ><rect
                    width="18"
                    height="12"
                    x="3"
                    y="6"
                    rx="2"
                    ry="2"
                  /><path d="M7 10h.01" /><path d="M11 10h.01" /><path
                    d="M15 10h.01"
                  /><path d="M17 10h.01" /><path d="M7 14h.01" /><path
                    d="M11 14h.01"
                  /><path d="M15 14h.01" /><path d="M17 14h.01" /></svg
                >
              </span>
              <span>Keyboard Shortcuts</span>
            </button>

            <button
              class="nav-item bg-transparent text-left"
              onclick={logout}
              type="button"
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
                  ><path d="M10 17l5-5-5-5" /><path d="M15 12H3" /><path
                    d="M21 19V5a2 2 0 0 0-2-2h-6"
                  /></svg
                >
              </span>
              <span>Log out</span>
            </button>
          {/if}

          <div
            class="sync-status"
            class:sync-status-attention={syncNeedsAttention}
            aria-live="polite"
          >
            <span
              class="sync-status-dot"
              class:sync-status-dot-offline={offlineState === 'offline'}
              class:sync-status-dot-attention={offlineState === 'blocked'}
            ></span>
            <span>
              {#if offlineState === 'offline'}
                Offline · cached
              {:else if offlineState === 'blocked'}
                Sync needs attention
              {:else if offlineState === 'queued'}
                {queuedActions} action{queuedActions === 1 ? '' : 's'} queued
              {:else if offlineState === 'syncing'}
                Syncing…
              {:else}
                Up to date
              {/if}
            </span>
          </div>
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

  <nav class="mobile-core-nav md:hidden" aria-label="Primary">
    {#each mobileCoreItems as item (item.href)}
      <a
        href={item.href}
        data-sveltekit-preload-data
        class={'mobile-core-nav-link' +
          ($page.url.pathname === item.href
            ? ' mobile-core-nav-link-active'
            : '')}
      >
        <span class="mobile-core-nav-icon">{@html item.icon}</span>
        <span>{item.label}</span>
        {#if item.href === '/inbox' && data.counts?.unread}
          <span class="mobile-core-nav-badge">{data.counts.unread}</span>
        {/if}
      </a>
    {/each}
    <button
      class={'mobile-core-nav-link' +
        (sidebarOpen ? ' mobile-core-nav-link-active' : '')}
      onclick={openMore}
      aria-label="Open more navigation"
      aria-expanded={sidebarOpen}
      aria-controls="app-sidebar"
      type="button"
    >
      <span class="mobile-core-nav-icon">
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
          ><circle cx="5" cy="12" r="1" /><circle
            cx="12"
            cy="12"
            r="1"
          /><circle cx="19" cy="12" r="1" /></svg
        >
      </span>
      <span>More</span>
    </button>
  </nav>

  {#if navigating.to?.url?.pathname?.startsWith('/articles/')}
    <div
      class="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-surface-950/80 backdrop-blur-sm"
      transition:fade={{ duration: 200 }}
    >
      <div
        class="h-8 w-8 animate-spin rounded-full border-4 border-primary-500 border-t-transparent"
      ></div>
      <p class="text-sm font-medium text-surface-200">
        {navigating.to?.url?.searchParams?.get('mode') === 'archive'
          ? 'Loading from Archive...'
          : 'Loading article...'}
      </p>
      {#if navigating.to?.url?.searchParams?.get('mode') === 'archive'}
        <p class="max-w-xs text-center text-xs text-surface-400">
          This may take a few moments as we retrieve the archived version.
        </p>
      {:else}
        <p class="max-w-xs text-center text-xs text-surface-400">
          We’re opening the article in the reader.
        </p>
      {/if}
    </div>
  {/if}

  <!-- Toast container -->
  <div
    class="fixed bottom-5 right-5 z-50 flex max-w-[min(24rem,calc(100vw-2rem))] flex-col gap-2.5"
    aria-live="polite"
    aria-atomic="false"
  >
    {#each toasts as toast (toast.id)}
      <div
        in:fly={{ y: 12, duration: 280, delay: 60 }}
        out:fly={{ y: 8, duration: 200 }}
        class="toast-glass rounded-[2px] px-4 py-2.5 text-sm font-medium text-white shadow-xl transition-all duration-300"
        role={toast.type === 'error' ? 'alert' : 'status'}
        class:toast-success={toast.type === 'success'}
        class:toast-error={toast.type === 'error'}
        class:toast-info={toast.type === 'info'}
        class:toast-warning={toast.type === 'warning'}
      >
        <span>{toast.message}</span>
        {#if toast.action}
          <button
            type="button"
            class="ml-3 underline decoration-primary-300 underline-offset-2 hover:text-primary-200"
            onclick={() => toast.action?.run()}>{toast.action.label}</button
          >
        {/if}
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
        bind:this={addFeedDialogEl}
        class="glass-card w-full max-w-md p-6 shadow-2xl"
        transition:fly={{ y: 20, duration: 300 }}
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-feed-title"
        tabindex="-1"
      >
        <div class="mb-4 flex items-center justify-between">
          <h3 id="add-feed-title" class="text-lg font-bold">Add New Feed</h3>
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
