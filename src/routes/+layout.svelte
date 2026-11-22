<script lang="ts">
  import '../app.css';
  import { onMount, setContext, tick } from 'svelte';
  import { renderContent } from '#lib/utils/format.ts';
  import { page } from '$app/state';
  import { navigating } from '$app/state';
  import {
    addToast,
    getToasts,
    pauseToast,
    removeToast,
    resumeToast,
  } from '#lib/stores/toast.svelte.ts';
  import { fade, fly } from 'svelte/transition';
  import { afterNavigate, invalidate, refreshAll } from '$app/navigation';
  import PWABanner from '#lib/components/PWABanner.svelte';
  import BrandMark from '#lib/components/BrandMark.svelte';
  import FeedSubscriptionForm from '#lib/components/FeedSubscriptionForm.svelte';
  import KeyboardShortcuts from '#lib/components/KeyboardShortcuts.svelte';
  import { getSingleKeyShortcutsEnabled } from '#lib/utils/keyboard-shortcuts.ts';

  import { syncFeeds } from '#lib/feeds.ts';
  import {
    activateOfflineUser,
    applyMutationToArticle,
    clearOfflinePrivateData,
    enqueueOfflineMutation,
    getOfflineSyncStatus,
    getCachedArticles,
    type OfflineArticle,
    type OfflineMutationType,
    installOfflineSync,
    retryBlockedOfflineMutations,
  } from '#lib/offline/index.ts';

  let sidebarOpen = $state(false);
  let isMobileViewport = $state(false);
  let sidebarEl = $state<HTMLElement | null>(null);
  let mainContentEl = $state<HTMLElement | null>(null);
  let mobileMoreButtonEl = $state<HTMLButtonElement | null>(null);
  let sidebarOpener: HTMLElement | null = null;
  let showShortcuts = $state(false);
  let syncing = $state(false);
  let offlineState = $state<
    'online' | 'offline' | 'queued' | 'blocked' | 'syncing'
  >('online');
  let queuedActions = $state(0);
  let syncNeedsAttention = $state(false);
  let syncNeedsSignIn = $state(false);
  let showAddFeedModal = $state(false);
  let addFeedDialogEl = $state<HTMLDivElement | null>(null);
  let addFeedPreviouslyFocused: HTMLElement | null = null;
  const toasts = getToasts();
  const sidebarFeedGroups = $derived.by(() => {
    type SidebarFeed = NonNullable<typeof data.feeds>[number];
    const groups: Record<string, SidebarFeed[]> = Object.create(null);
    for (const feed of data.feeds || []) {
      const group = feed.category?.trim() || '';
      const entries = groups[group] || (groups[group] = []);
      entries.push(feed);
    }
    return Object.entries(groups).sort(([left], [right]) =>
      left.localeCompare(right),
    );
  });
  const modalCategories = $derived.by(() => {
    if (Array.isArray(data.feedCategories)) return data.feedCategories;
    return sidebarFeedGroups
      .map(([category]) => category)
      .filter((category) => category.length > 0);
  });
  let stopOfflineSync: (() => void) | null = null;
  let { children, data } = $props();
  const sessionId = $derived(data.sessionId);
  const userId = $derived(String(data.userId || 'admin'));

  let cachedReader = $state<HTMLDialogElement>();
  let cachedArticle = $state<OfflineArticle | null>(null);

  onMount(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const updateViewport = () => {
      isMobileViewport = media.matches;
      if (!media.matches) sidebarOpen = false;
    };
    updateViewport();
    media.addEventListener('change', updateViewport);
    return () => media.removeEventListener('change', updateViewport);
  });

  $effect(() => {
    if (!isMobileViewport || !sidebarOpen || showAddFeedModal || showShortcuts)
      return;

    const sidebar = sidebarEl;
    if (!sidebar) return;
    const getFocusableElements = () =>
      Array.from(
        sidebar.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);

    void tick().then(() => {
      if (sidebarOpen && isMobileViewport) getFocusableElements()[0]?.focus();
    });

    const handleSidebarKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSidebar(true);
        return;
      }
      if (event.key !== 'Tab') return;

      const focusableElements = getFocusableElements();
      if (!focusableElements.length) {
        event.preventDefault();
        sidebar.focus();
        return;
      }
      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const active = document.activeElement;
      if (!sidebar.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleSidebarKeydown);
    return () => document.removeEventListener('keydown', handleSidebarKeydown);
  });

  afterNavigate(() => {
    showAddFeedModal = false;
    showShortcuts = false;
    if (cachedReader?.open) {
      cachedReader.close();
    }
    if (!sidebarOpen || !isMobileViewport) {
      sidebarOpen = false;
      return;
    }
    sidebarOpen = false;
    void tick().then(() => mainContentEl?.focus());
  });

  setContext('openCachedArticle', async (article: OfflineArticle) => {
    if (!sessionId || !cachedReader) return;
    cachedArticle = article;
    await tick();
    if (!cachedReader.open) {
      cachedReader.showModal();
    }
    const scope = userId;
    const cached = await getCachedArticles(scope).catch(() => []);
    if (cachedReader?.open && cachedArticle?.id === article.id && sessionId) {
      const matched = cached.find((entry) => entry.id === article.id);
      if (matched) {
        cachedArticle = {
          ...matched,
          read: Boolean(article.read || matched.read),
        };
      }
    }
  });

  let cachedActionPending = $state(false);

  async function updateCachedArticle(type: OfflineMutationType) {
    const article = cachedArticle;
    if (!article || cachedActionPending) return;
    cachedActionPending = true;
    try {
      await enqueueOfflineMutation(userId, {
        articleId: article.id,
        type,
      });
      if (cachedArticle?.id === article.id) {
        const updated = applyMutationToArticle(cachedArticle, type);
        cachedArticle = updated;
        window.dispatchEvent(
          new CustomEvent('feed-me-maybe:offline-article-updated', {
            detail: updated,
          }),
        );
      }
      addToast('Action queued for sync', 'info');
      void refreshOfflineStatus(userId);
    } catch {
      addToast('Could not queue the article action', 'error');
    } finally {
      cachedActionPending = false;
    }
  }

  function openAddFeedModal() {
    addFeedPreviouslyFocused =
      isMobileViewport && sidebarOpen
        ? mobileMoreButtonEl
        : (document.activeElement as HTMLElement | null);
    if (isMobileViewport && sidebarOpen) closeSidebar(false);
    showAddFeedModal = true;
  }

  setContext('openAddFeed', openAddFeedModal);

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

  function isOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  async function refreshOfflineStatus(scope: string) {
    if (typeof window === 'undefined') return;

    try {
      const status = await getOfflineSyncStatus(scope);
      syncNeedsSignIn = status.needsSignIn;
      applyOfflineStatus(status.pendingCount, status.state === 'blocked');
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
      void refreshOfflineStatus(userId);
    }
  }

  async function retryOfflineActions() {
    if (syncing || isOffline()) {
      return;
    }

    const scope = userId;
    syncing = true;
    offlineState = 'syncing';
    try {
      const result = await retryBlockedOfflineMutations(scope);
      applyOfflineStatus(
        result.remaining,
        result.blocked > 0 || result.conflicts > 0,
      );
      if (result.synced > 0) {
        void refreshAll();
        addToast(
          `${result.synced} offline action${result.synced === 1 ? '' : 's'} synced`,
          'success',
        );
      }
      if (result.blocked > 0 || result.conflicts > 0) {
        addToast('An offline action still needs your attention', 'error');
      }
    } catch {
      addToast('Could not retry offline actions.', 'error');
    } finally {
      syncing = false;
      void refreshOfflineStatus(scope);
    }
  }

  // Trigger sync on open and visibility change
  $effect(() => {
    if (!sessionId) return;

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

  async function handleFeedSubscribed() {
    showAddFeedModal = false;
    addToast('Feed added successfully', 'success');
    // Refresh the page to show the new feed in the sidebar
    await refreshAll();
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
    if (typeof window === 'undefined' || !sessionId) return;

    const scope = userId;
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
              void refreshAll();
              addToast(
                `${result.synced} offline action${result.synced === 1 ? '' : 's'} synced`,
                'success',
              );
            }
            if (result.blocked > 0 || result.conflicts > 0) {
              void refreshOfflineStatus(scope);
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
    if (typeof window === 'undefined' || !sessionId) return;

    const scope = userId;
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

    if (!addFeedPreviouslyFocused) {
      addFeedPreviouslyFocused = document.activeElement as HTMLElement | null;
    }
    requestAnimationFrame(() => addFeedDialogEl?.focus());
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        showAddFeedModal = false;
        return;
      }

      if (event.key !== 'Tab' || !addFeedDialogEl) return;

      const focusableElements = Array.from(
        addFeedDialogEl.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);

      if (focusableElements.length === 0) {
        event.preventDefault();
        addFeedDialogEl.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (!addFeedDialogEl.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (
        event.shiftKey &&
        (activeElement === first || activeElement === addFeedDialogEl)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (activeElement === last || activeElement === addFeedDialogEl)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeydown);

    return () => {
      document.removeEventListener('keydown', handleKeydown);
      if (addFeedPreviouslyFocused?.isConnected) {
        addFeedPreviouslyFocused.focus();
      } else {
        mainContentEl?.focus();
      }
      addFeedPreviouslyFocused = null;
    };
  });

  $effect(() => {
    const handleShortcutHelp = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      // Honor the same opt-out as article shortcuts, and keep dialogs exclusive.
      if (
        !getSingleKeyShortcutsEnabled() ||
        showAddFeedModal ||
        showShortcuts ||
        document.querySelector('dialog[open], [aria-modal="true"]')
      ) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.closest(
          'input, textarea, select, [role="dialog"], [aria-modal="true"]',
        )
      ) {
        return;
      }

      event.preventDefault();
      showShortcuts = true;
    };

    document.addEventListener('keydown', handleShortcutHelp);
    return () => document.removeEventListener('keydown', handleShortcutHelp);
  });

  const navItems = [
    { href: '/', label: 'All' },
    { href: '/inbox', label: 'Unread' },
    { href: '/search', label: 'Search' },
    { href: '/saved', label: 'Saved' },
    { href: '/digest', label: 'Briefing' },
    { href: '/feeds', label: 'Feeds' },
  ];

  const mobileCoreItems = navItems.filter((item) =>
    ['/', '/inbox', '/search', '/saved'].includes(item.href),
  );

  function isCurrentNavItem(href: string): boolean {
    const path = page.url.pathname;
    if (
      (href === '/' || href === '/inbox') &&
      page.url.searchParams.has('category')
    )
      return false;
    return href === '/'
      ? path === '/'
      : path === href || path.startsWith(`${href}/`);
  }

  const adminItems = [{ href: '/settings', label: 'Settings' }];

  let secondaryOpen = $state(false);

  function closeSidebar(restoreFocus = false) {
    const focusTarget = sidebarOpener || mobileMoreButtonEl;
    sidebarOpen = false;
    if (restoreFocus && focusTarget) {
      void tick().then(() => focusTarget.focus());
    }
  }

  function openMore() {
    sidebarOpener = document.activeElement as HTMLElement | null;
    secondaryOpen = true;
    sidebarOpen = true;
  }

  $effect(() => {
    const path = page.url.pathname;
    if (path.startsWith('/recovery') || path.startsWith('/settings')) {
      secondaryOpen = true;
    }
  });

  // Real-time updates via SSE
  $effect(() => {
    if (!sessionId) return;

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

      eventSource.addEventListener('new_articles', (event) => {
        try {
          const payload = JSON.parse(event.data);

          if (Array.isArray(payload.articles)) {
            const ids = payload.articles.filter(
              (id: unknown): id is string =>
                typeof id === 'string' && id.length > 0 && id.length <= 128,
            );
            if (ids.length > 0) {
              void invalidate('app:reader-counts');
              window.dispatchEvent(
                new CustomEvent('feed-me-maybe:new-articles', {
                  detail: { ids },
                }),
              );
            }
          }
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

{#snippet navIcon(href: string)}
  {#if href === '/'}
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
      ><circle cx="12" cy="12" r="5" /><path
        d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
      /></svg
    >
  {:else if href === '/inbox'}
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
      ><path d="M4 4h16v14H4z" /><path d="M4 14h4l2 3h4l2-3h4" /><path
        d="M8 8h8"
      /></svg
    >
  {:else if href === '/search'}
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
      ><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg
    >
  {:else if href === '/saved'}
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
      ><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" /></svg
    >
  {:else if href === '/digest'}
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
      ><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><path
        d="M8 2v4"
      /><path d="M16 2v4" /><path d="M3 10h18" /><path d="M8 14h.01" /><path
        d="M12 14h.01"
      /><path d="M16 14h.01" /><path d="M8 18h.01" /><path
        d="M12 18h.01"
      /></svg
    >
  {:else if href === '/feeds'}
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
        d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"
      /><path d="M8 7h8M8 11h8M8 15h5" /></svg
    >
  {:else if href === '/settings'}
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
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
      /><circle cx="12" cy="12" r="3" /></svg
    >
  {/if}
{/snippet}

<!-- Cinematic Background -->
<a class="skip-link" href="#main-content">Skip to content</a>

<div class="cinematic-bg" aria-hidden="true">
  <div class="cinematic-bg-orb cinematic-bg-orb-1"></div>
  <div class="cinematic-bg-orb cinematic-bg-orb-2"></div>
  <div class="cinematic-bg-orb cinematic-bg-orb-3"></div>
</div>
<div class="grain-overlay" aria-hidden="true"></div>
<div class="vignette" aria-hidden="true"></div>

{#if sessionId}
  <div class="relative z-10 flex h-dvh flex-col">
    <div class="flex flex-1 overflow-hidden">
      <!-- Sidebar overlay (mobile) -->
      {#if sidebarOpen}
        <div
          class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          onclick={() => closeSidebar(true)}
          onkeydown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              closeSidebar(true);
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
        bind:this={sidebarEl}
        class="glass-sidebar fixed left-0 top-0 z-50 h-dvh w-56 transform transition-transform duration-300 ease-out max-md:pt-[env(safe-area-inset-top)] md:static md:top-0 md:h-dvh md:translate-x-0 {sidebarOpen
          ? ''
          : 'max-md:invisible'}"
        class:translate-x-0={sidebarOpen}
        class:-translate-x-full={!sidebarOpen}
        inert={isMobileViewport && !sidebarOpen}
        role={isMobileViewport && sidebarOpen ? 'dialog' : undefined}
        aria-modal={isMobileViewport && sidebarOpen ? 'true' : undefined}
        aria-label="Application navigation"
      >
        <div class="flex items-center justify-between p-2">
          <a
            href="/"
            data-sveltekit-preload-data
            class="hidden items-center gap-2 no-underline md:inline-flex"
          >
            <BrandMark size={32} class="shrink-0" />
            <span class="gradient-text text-lg font-bold tracking-tight">
              Feed Me <span class="italic">Maybe</span>
            </span>
          </a>
          {#if isMobileViewport && sidebarOpen}
            <button
              type="button"
              class="btn-icon ml-auto md:hidden"
              onclick={() => closeSidebar(true)}
              aria-label="Close navigation"
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
          {/if}
        </div>

        <div
          class="flex h-[calc(100%-3.5rem)] min-h-0 flex-col justify-between overflow-y-auto p-3 md:h-[calc(100%-4rem)]"
        >
          <nav
            class="flex shrink-0 flex-col gap-1"
            aria-label="Primary navigation"
          >
            {#each navItems as item (item.href)}
              <a
                href={item.href}
                data-sveltekit-preload-data
                class={'nav-item' +
                  (isCurrentNavItem(item.href) ? ' nav-item-active' : '')}
                aria-current={isCurrentNavItem(item.href) ? 'page' : undefined}
              >
                <span class="flex h-5 w-5 items-center justify-center"
                  >{@render navIcon(item.href)}</span
                >
                <span class="min-w-0 flex-1 truncate">{item.label}</span>
              </a>
            {/each}

            <div class="mt-4 flex items-center justify-between px-3 pb-1">
              <div
                class="text-[10px] font-bold uppercase tracking-widest"
                style="color: var(--color-surface-300);"
              >
                Sources
              </div>
              <button
                type="button"
                class="nav-icon-button"
                onclick={openAddFeedModal}
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
            {#if data.feeds && data.feeds.length > 0}
              <details
                class="nav-feed-group"
                open={page.url.pathname.startsWith('/feeds/') ||
                  page.url.searchParams.has('category')}
              >
                <summary class="nav-feed-summary">
                  <span>Browse sources</span>
                  <span class="text-[10px] text-surface-300"
                    >{data.feeds.length}</span
                  >
                </summary>
                <div class="mt-1 flex flex-col gap-1">
                  {#each sidebarFeedGroups as [category, feeds] (category)}
                    {#if category}
                      <details
                        open={feeds.some(
                          (feed) => page.url.pathname === `/feeds/${feed.id}`,
                        ) || page.url.searchParams.get('category') === category}
                      >
                        <summary class="nav-feed-summary">
                          <span>{category}</span>
                          <span
                            >{feeds.reduce(
                              (total, feed) => total + feed.unread_count,
                              0,
                            )} unread</span
                          >
                        </summary>
                        <a
                          class="nav-item nav-item-subtle"
                          href="/?category={encodeURIComponent(category)}"
                          aria-current={page.url.pathname === '/' &&
                          page.url.searchParams.get('category') === category
                            ? 'page'
                            : undefined}>All {category}</a
                        >
                        <a
                          class="nav-item nav-item-subtle"
                          href="/inbox?category={encodeURIComponent(category)}"
                          aria-current={page.url.pathname === '/inbox' &&
                          page.url.searchParams.get('category') === category
                            ? 'page'
                            : undefined}>Unread {category}</a
                        >
                        {#each feeds as feed (feed.id)}
                          {@render feedLink(feed)}
                        {/each}
                      </details>
                    {:else}
                      {#each feeds as feed (feed.id)}
                        {@render feedLink(feed)}
                      {/each}
                    {/if}
                  {/each}
                </div>
                {#snippet feedLink(feed: (typeof data.feeds)[number])}
                  <a
                    href="/feeds/{feed.id}"
                    aria-current={page.url.pathname === `/feeds/${feed.id}`
                      ? 'page'
                      : undefined}
                    data-sveltekit-preload-data
                    class={'nav-item nav-item-subtle' +
                      (page.url.pathname === `/feeds/${feed.id}`
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
                          style="color: var(--color-surface-300);"
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
                {/snippet}
              </details>
            {:else if (data.pausedFeeds ?? 0) > 0}
              <a
                href="/feeds"
                data-sveltekit-preload-data
                class="nav-item nav-item-subtle text-xs text-surface-300"
              >
                <span>
                  {data.pausedFeeds} paused {data.pausedFeeds === 1
                    ? 'feed'
                    : 'feeds'}
                </span>
              </a>
            {/if}

            <button
              class="nav-item mt-4 hidden w-full items-center gap-3 bg-transparent text-left md:flex"
              onclick={handleManualSync}
              disabled={syncing}
              aria-busy={syncing}
              type="button"
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
                  class="flex h-5 w-5 items-center justify-center text-surface-300"
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

            <div
              id="secondary-navigation"
              class="flex flex-col gap-1"
              hidden={!secondaryOpen}
            >
              <a
                href="/recovery"
                data-sveltekit-preload-data
                class={'nav-item' +
                  (page.url.pathname.startsWith('/recovery')
                    ? ' nav-item-active'
                    : '')}
                aria-current={page.url.pathname.startsWith('/recovery')
                  ? 'page'
                  : undefined}
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
              {#each adminItems as item (item.href)}
                <a
                  href={item.href}
                  data-sveltekit-preload-data
                  class={'nav-item' +
                    (page.url.pathname.startsWith(item.href)
                      ? ' nav-item-active'
                      : '')}
                  aria-current={page.url.pathname.startsWith(item.href)
                    ? 'page'
                    : undefined}
                >
                  <span class="flex h-5 w-5 items-center justify-center"
                    >{@render navIcon(item.href)}</span
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
            </div>

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
              {#if offlineState === 'blocked' && syncNeedsSignIn}
                <a
                  class="ml-2 text-xs underline underline-offset-2"
                  href="/login">Sign in</a
                >
              {:else if offlineState === 'blocked'}
                <button
                  class="ml-2 text-xs underline underline-offset-2"
                  type="button"
                  disabled={syncing || isOffline()}
                  onclick={retryOfflineActions}
                >
                  Retry
                </button>
              {/if}
            </div>
          </nav>
        </div>
      </aside>

      <!-- Main Content -->
      <main
        id="main-content"
        bind:this={mainContentEl}
        tabindex="-1"
        class="relative flex-1 overflow-auto md:p-8"
        aria-busy={Boolean(navigating.to)}
        inert={isMobileViewport && sidebarOpen}
      >
        {@render children()}
      </main>
    </div>

    {#if offlineState !== 'online'}
      <div
        class="bg-surface-900 px-3 py-1 text-center text-xs text-surface-200 md:hidden"
        role="status"
        inert={isMobileViewport && sidebarOpen}
      >
        {#if offlineState === 'blocked'}
          <span>Sync needs attention</span>
          {#if syncNeedsSignIn}
            <a class="ml-2 underline underline-offset-2" href="/login"
              >Sign in</a
            >
          {:else}
            <button
              class="ml-2 underline underline-offset-2"
              type="button"
              disabled={syncing || isOffline()}
              onclick={retryOfflineActions}
            >
              Retry
            </button>
          {/if}
        {:else if offlineState === 'syncing'}
          Syncing…
        {:else}
          {offlineState === 'offline'
            ? 'Offline'
            : 'Online'}{#if queuedActions > 0}
            · {queuedActions} queued{/if}
        {/if}
      </div>
    {/if}

    <nav
      class="mobile-core-nav md:hidden"
      aria-label="Mobile primary navigation"
      inert={isMobileViewport && sidebarOpen}
    >
      {#each mobileCoreItems as item (item.href)}
        <a
          href={item.href}
          data-sveltekit-preload-data
          class={'mobile-core-nav-link' +
            (isCurrentNavItem(item.href) ? ' mobile-core-nav-link-active' : '')}
          aria-current={isCurrentNavItem(item.href) ? 'page' : undefined}
        >
          <span class="mobile-core-nav-icon">{@render navIcon(item.href)}</span>
          <span>{item.label}</span>
        </a>
      {/each}
      <button
        class={'mobile-core-nav-link' +
          (sidebarOpen ? ' mobile-core-nav-link-active' : '')}
        onclick={openMore}
        bind:this={mobileMoreButtonEl}
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
        role="status"
        aria-live="polite"
        aria-atomic="true"
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
          <p class="max-w-xs text-center text-xs text-surface-300">
            This may take a few moments as we retrieve the archived version.
          </p>
        {:else}
          <p class="max-w-xs text-center text-xs text-surface-300">
            We’re opening the article in the reader.
          </p>
        {/if}
      </div>
    {/if}

    <dialog
      bind:this={cachedReader}
      aria-labelledby="offline-article-title"
      class="fixed inset-0 m-auto max-h-[90dvh] w-[min(45rem,calc(100%-2rem))] overflow-auto rounded-md bg-surface-900 p-5 text-surface-100 backdrop:bg-black/70 md:p-8"
      onclose={() => (cachedArticle = null)}
    >
      <form
        method="dialog"
        class="sticky top-0 mb-4 flex items-center justify-between gap-3 bg-surface-900 py-2"
      >
        <span class="text-sm text-surface-300">Offline article</span>
        <button type="submit" class="btn preset-filled-surface-200-800"
          >Close</button
        >
      </form>
      {#if cachedArticle}
        <h1 id="offline-article-title" class="mb-4 text-2xl font-semibold">
          {cachedArticle.title}
        </h1>
        {#if cachedArticle.content || cachedArticle.summary}
          <div class="prose-glass overflow-x-auto">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html renderContent(
              cachedArticle.content || cachedArticle.summary,
              cachedArticle.url,
            )}
          </div>
        {:else}
          <p>This article’s text is unavailable offline.</p>
        {/if}
        <div
          class="mt-4 flex flex-wrap gap-2"
          role="group"
          aria-label="Offline article actions"
        >
          <button
            type="button"
            class="btn preset-tonal"
            disabled={cachedActionPending}
            onclick={() =>
              updateCachedArticle(cachedArticle?.read ? 'unread' : 'read')}
          >
            {cachedArticle.read ? 'Mark unread' : 'Mark read'}
          </button>
          <button
            type="button"
            class="btn preset-tonal"
            disabled={cachedActionPending}
            onclick={() =>
              updateCachedArticle(cachedArticle?.saved ? 'unsave' : 'save')}
          >
            {cachedArticle.saved ? 'Unsave' : 'Save'}
          </button>
          <button
            type="button"
            class="btn preset-tonal"
            disabled={cachedActionPending}
            onclick={() =>
              updateCachedArticle(
                cachedArticle?.hidden || cachedArticle?.thumbs_down
                  ? 'restore'
                  : 'hide',
              )}
          >
            {cachedArticle.hidden || cachedArticle.thumbs_down
              ? 'Restore'
              : 'Hide'}
          </button>
        </div>
      {/if}
      {#if cachedArticle && toasts.length > 0}
        <div
          class="app-toasts fixed right-5 bottom-5 z-50 flex max-h-[40dvh] max-w-[min(24rem,calc(100vw-2rem))] flex-col gap-2.5 overflow-y-auto"
          aria-live="polite"
          aria-atomic="false"
        >
          {#each toasts as toast (toast.id)}
            {@render toastCard(toast)}
          {/each}
        </div>
      {/if}
    </dialog>

    {#snippet toastCard(toast: (typeof toasts)[number])}
      <div
        in:fly={{ y: 12, duration: 280, delay: 60 }}
        out:fade={{ duration: 120 }}
        class="toast-glass flex items-center gap-2 rounded-[2px] px-3 py-2 text-sm font-medium text-white shadow-xl transition-all duration-300"
        role={toast.type === 'error' ? 'alert' : 'status'}
        class:toast-success={toast.type === 'success'}
        class:toast-error={toast.type === 'error'}
        class:toast-info={toast.type === 'info'}
        class:toast-warning={toast.type === 'warning'}
        onmouseenter={() => pauseToast(toast.id, 'hover')}
        onmouseleave={() => resumeToast(toast.id, 'hover')}
        onfocusin={() => pauseToast(toast.id, 'focus')}
        onfocusout={(event) => {
          const nextTarget = event.relatedTarget as Node | null;
          if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
            resumeToast(toast.id, 'focus');
          }
        }}
      >
        <span class="min-w-0 flex-1">{toast.message}</span>
        {#if toast.action}
          <button
            type="button"
            class="shrink-0 underline decoration-primary-300 underline-offset-2 hover:text-primary-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-300"
            onclick={async (event) => {
              const button = event.currentTarget;
              await toast.action?.run();
              if (document.activeElement === button) {
                document.getElementById('main-content')?.focus();
              }
              removeToast(toast.id);
            }}>{toast.action.label}</button
          >
        {/if}
        <button
          type="button"
          class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/75 transition hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
          aria-label="Dismiss notification"
          onclick={(event) => {
            if (document.activeElement === event.currentTarget) {
              document.getElementById('main-content')?.focus();
            }
            removeToast(toast.id);
          }}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            class="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          >
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
    {/snippet}

    {#if !cachedArticle}
      <!-- Toast container -->
      <div
        class="app-toasts fixed right-5 bottom-[calc(var(--fmm-mobile-nav-height)+1.25rem+env(safe-area-inset-bottom))] z-50 flex max-h-[50dvh] max-w-[min(24rem,calc(100vw-2rem))] flex-col gap-2.5 overflow-y-auto md:bottom-5"
        aria-live="polite"
        aria-atomic="false"
      >
        {#each toasts as toast (toast.id)}
          {@render toastCard(toast)}
        {/each}
      </div>
    {/if}

    {#if showAddFeedModal}
      <div
        class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-md"
        transition:fade={{ duration: 200 }}
        onclick={(event) => {
          if (event.target === event.currentTarget) showAddFeedModal = false;
        }}
        role="presentation"
      >
        <div
          bind:this={addFeedDialogEl}
          class="glass-card max-h-[90dvh] w-full max-w-md overflow-y-auto p-6 shadow-2xl"
          transition:fly={{ y: 20, duration: 300 }}
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

          <FeedSubscriptionForm
            idPrefix="modal-feed"
            categories={modalCategories}
            submitLabel="Add Feed"
            submittingLabel="Adding..."
            onCancel={() => (showAddFeedModal = false)}
            onSuccess={handleFeedSubscribed}
          />
        </div>
      </div>
    {/if}

    {#if !page.url.pathname.startsWith('/articles/')}
      <PWABanner />
    {/if}
    <KeyboardShortcuts
      bind:open={showShortcuts}
      reader={page.url.pathname.startsWith('/articles/')}
    />
  </div>
{:else}
  <main id="main-content" tabindex="-1" class="relative z-10 min-h-dvh">
    {@render children()}
  </main>
{/if}

<style>
  /* Svelte keeps exiting elements mounted until their fade finishes. */
  .app-toasts > .toast-glass:nth-last-child(n + 3) {
    display: none;
  }
</style>
