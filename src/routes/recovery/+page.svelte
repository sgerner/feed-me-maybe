<script lang="ts">
  import { getContext, onDestroy, onMount, tick } from 'svelte';
  import { SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
  import { goto, invalidate } from '$app/navigation';
  import { page as pageStore } from '$app/state';
  import { addToast } from '#lib/stores/toast.svelte.ts';
  import { fetchWithCsrf } from '#lib/client/csrf.ts';
  import {
    applyMutationToCachedArticle,
    enqueueOfflineMutation,
    getCachedArticles,
    matchesOfflineVisibility,
    type OfflineArticle,
  } from '#lib/offline/index.ts';
  import {
    buildReaderArticleHref,
    READER_QUEUE_STORAGE_KEY,
    serializeReaderQueue,
    validateStreamOrigin,
  } from '#lib/reader-queue.ts';

  type HideReason =
    'preference_model' | 'manual_hide' | 'rejected' | 'hide_on_open';

  type RecoveryReasonFilter = 'actionable' | 'all' | HideReason;

  type RecoveryReasonCounts = {
    actionable: number;
    all: number;
    preference_model: number;
    manual_hide: number;
    rejected: number;
    hide_on_open: number;
  };

  type RecoveryFeedOption = {
    id: string;
    title: string;
    enabled: boolean;
    count: number;
  };

  type RecoveryArticle = {
    id: string;
    title: string;
    url: string;
    feedId?: string;
    feedTitle: string;
    read: boolean;
    saved: boolean;
    hidden: boolean;
    rejected: boolean;
    thumbsDown: boolean;
    hideReason?: HideReason;
    stateChangedAt?: number | null;
    cached?: OfflineArticle;
  };

  const MAX_BATCH_RESTORE = 500;
  const PAGE_LIMIT = 50;

  const REASON_OPTIONS: ReadonlyArray<{
    value: RecoveryReasonFilter;
    label: string;
  }> = [
    { value: 'actionable', label: 'Actionable' },
    { value: 'preference_model', label: 'Auto-hidden' },
    { value: 'manual_hide', label: 'Manual' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'hide_on_open', label: 'Hidden on open' },
    { value: 'all', label: 'All' },
  ];

  const EMPTY_COUNTS: RecoveryReasonCounts = {
    actionable: 0,
    all: 0,
    preference_model: 0,
    manual_hide: 0,
    rejected: 0,
    hide_on_open: 0,
  };

  let articles = $state<RecoveryArticle[]>([]);
  let reasonCounts = $state<RecoveryReasonCounts>({ ...EMPTY_COUNTS });
  let feeds = $state<RecoveryFeedOption[]>([]);
  let selectedReason = $state<RecoveryReasonFilter>('actionable');
  let selectedFeedId = $state('');
  let searchInput = $state('');
  let appliedQuery = $state('');
  let selectedIds = new SvelteSet<string>();

  let loading = $state(true);
  let loadingMore = $state(false);
  let errorMessage = $state('');
  let statusAnnouncement = $state('');
  let restoring = $state<Record<string, boolean>>({});
  let batchRestoring = $state(false);
  let heading = $state<HTMLHeadingElement>();
  let nextCursor = $state<string | null>(null);
  let offlineFallback = $state(false);

  let requestSequence = 0;
  let activeController: AbortController | null = null;
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  const openCachedArticle = getContext<
    ((article: OfflineArticle) => Promise<void>) | undefined
  >('openCachedArticle');

  const selectableArticles = $derived(articles.slice(0, MAX_BATCH_RESTORE));
  const selectedCount = $derived(selectedIds.size);
  const allSelectableSelected = $derived(
    selectableArticles.length > 0 &&
      selectableArticles.every((article) => selectedIds.has(article.id)),
  );
  const partiallySelected = $derived(
    selectedCount > 0 && !allSelectableSelected,
  );

  function setIndeterminate(node: HTMLInputElement, value: boolean) {
    node.indeterminate = value;
    return {
      update(nextValue: boolean) {
        node.indeterminate = nextValue;
      },
    };
  }

  function offlineScope(): string {
    return String(pageStore.data.userId || 'admin');
  }

  const recoverySource = $derived(
    validateStreamOrigin(`${pageStore.url.pathname}${pageStore.url.search}`) ??
      '/recovery',
  );

  function recoveryArticleHref(articleId: string): string {
    return buildReaderArticleHref(articleId, { from: recoverySource });
  }

  function writeRecoveryReaderQueue(): void {
    try {
      const serialized = serializeReaderQueue({
        ids: articles.map((item) => item.id),
        source: recoverySource,
        pagination:
          !offlineFallback && nextCursor
            ? {
                kind: 'recovery',
                nextCursor,
                limit: PAGE_LIMIT,
                feedId: selectedFeedId || null,
                reason: selectedReason,
                query: appliedQuery.trim(),
              }
            : null,
      });
      if (serialized) {
        sessionStorage.setItem(READER_QUEUE_STORAGE_KEY, serialized);
      }
    } catch {
      // Direct reader navigation still works without session storage.
    }
  }

  function effectiveHideReason(article: RecoveryArticle): HideReason {
    if (article.hideReason) return article.hideReason;
    if (article.rejected || article.thumbsDown) return 'rejected';
    return 'manual_hide';
  }

  function reasonBadge(reason: HideReason): {
    label: string;
    classes: string;
  } {
    switch (reason) {
      case 'preference_model':
        return {
          label: 'Auto-hidden',
          classes:
            'border border-warning-400/35 bg-warning-500/15 text-warning-200',
        };
      case 'manual_hide':
        return {
          label: 'Manual',
          classes:
            'border border-secondary-400/35 bg-secondary-500/15 text-secondary-200',
        };
      case 'rejected':
        return {
          label: 'Rejected',
          classes: 'border border-error-400/35 bg-error-500/15 text-error-200',
        };
      case 'hide_on_open':
        return {
          label: 'Hidden on open',
          classes: 'border border-white/15 bg-white/5 text-surface-200',
        };
    }
  }

  function reasonFilterLabel(reason: RecoveryReasonFilter): string {
    return (
      REASON_OPTIONS.find((item) => item.value === reason)?.label || 'Recovery'
    );
  }

  function matchesActiveReason(
    reason: HideReason,
    filter: RecoveryReasonFilter,
  ): boolean {
    if (filter === 'all') return true;
    if (filter === 'actionable') return reason !== 'hide_on_open';
    return reason === filter;
  }

  function buildLoadedAnnouncement(count: number, cached = false): string {
    const label = reasonFilterLabel(selectedReason).toLowerCase();
    const parts: string[] = [];
    if (selectedFeedId) {
      const feedName =
        feeds.find((feed) => feed.id === selectedFeedId)?.title ||
        'selected feed';
      parts.push(`in ${feedName}`);
    }
    if (appliedQuery.trim()) {
      parts.push(`matching "${appliedQuery.trim()}"`);
    }
    const suffix = parts.length ? ` ${parts.join(' ')}` : '';
    const prefix = cached ? 'Showing ' : '';
    const cachedWord = cached ? 'cached ' : '';
    const noun = count === 1 ? 'article' : 'articles';
    if (count === 0) {
      return `0 ${cachedWord}${label} recovery articles${suffix}.`;
    }
    return `${prefix}${count} ${cachedWord}${label} recovery ${noun}${suffix} loaded.`;
  }

  function parseInitialFiltersFromUrl() {
    const searchParams = pageStore.url.searchParams;
    const rawReason = searchParams.get('reason')?.trim().toLowerCase();
    if (
      rawReason &&
      REASON_OPTIONS.some((option) => option.value === rawReason)
    ) {
      selectedReason = rawReason as RecoveryReasonFilter;
    }
    const rawFeedId = searchParams.get('feedId')?.trim();
    if (rawFeedId) {
      selectedFeedId = rawFeedId;
    }
    const rawQuery = searchParams.get('q');
    if (rawQuery !== null) {
      searchInput = rawQuery;
      appliedQuery = rawQuery.trim();
    }
  }

  async function syncUrlFilters() {
    const params = new SvelteURLSearchParams();
    if (selectedReason !== 'actionable') {
      params.set('reason', selectedReason);
    }
    if (selectedFeedId) {
      params.set('feedId', selectedFeedId);
    }
    if (appliedQuery.trim()) {
      params.set('q', appliedQuery.trim());
    }
    const queryString = params.toString();
    const target = `/recovery${queryString ? `?${queryString}` : ''}`;
    const current = `${pageStore.url.pathname}${pageStore.url.search}`;
    if (target !== current) {
      try {
        await goto(target, {
          replaceState: true,
          reset: false,
        });
      } catch {
        // Ignore URL sync errors in non-navigation contexts.
      }
    }
  }

  async function loadCachedRecoveryFallback(): Promise<boolean> {
    try {
      const cached = await getCachedArticles(offlineScope());
      const hiddenOrRejected = cached.filter(
        (item) =>
          item.cleared_at == null &&
          (matchesOfflineVisibility(item, 'hidden') ||
            matchesOfflineVisibility(item, 'rejected')),
      );

      const feedMap: Record<string, RecoveryFeedOption> = Object.create(null);
      for (const item of hiddenOrRejected) {
        const id = String(item.feed_id || '');
        if (!id) continue;
        const entry =
          feedMap[id] ||
          (feedMap[id] = {
            id,
            title: item.feed_title || 'Unknown source',
            enabled: true,
            count: 0,
          });
        entry.count += 1;
      }
      feeds = Object.values(feedMap).sort((a, b) =>
        a.title.localeCompare(b.title),
      );

      const mapped: RecoveryArticle[] = hiddenOrRejected.map((item) => {
        const hideReason: HideReason = item.thumbs_down
          ? 'rejected'
          : 'manual_hide';
        return {
          id: item.id,
          title: item.title,
          url: item.url,
          feedId: item.feed_id ?? undefined,
          feedTitle: item.feed_title || 'Unknown source',
          read: Boolean(item.read),
          saved: Boolean(item.saved),
          hidden: Boolean(item.hidden),
          rejected: Boolean(item.thumbs_down),
          thumbsDown: Boolean(item.thumbs_down),
          hideReason,
          stateChangedAt: item.updatedAt,
          cached: item,
        };
      });

      const queryTerm = appliedQuery.trim().toLowerCase();
      const feedAndQueryMatched = mapped.filter((article) => {
        if (selectedFeedId && article.feedId !== selectedFeedId) return false;
        if (!queryTerm) return true;
        const blob =
          `${article.title} ${article.feedTitle} ${article.cached?.author || ''} ${article.cached?.summary || ''} ${article.cached?.content || ''}`.toLowerCase();
        return blob.includes(queryTerm);
      });

      const nextCounts: RecoveryReasonCounts = { ...EMPTY_COUNTS };
      for (const item of feedAndQueryMatched) {
        const reason = effectiveHideReason(item);
        nextCounts[reason] += 1;
        nextCounts.all += 1;
        if (reason !== 'hide_on_open') nextCounts.actionable += 1;
      }
      reasonCounts = nextCounts;

      articles = feedAndQueryMatched.filter((item) =>
        matchesActiveReason(effectiveHideReason(item), selectedReason),
      );
      nextCursor = null;
      offlineFallback = true;
      errorMessage = '';
      statusAnnouncement = buildLoadedAnnouncement(articles.length, true);
      return true;
    } catch {
      return false;
    }
  }

  async function responseErrorMessage(
    response: Response,
    fallback: string,
  ): Promise<string> {
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload.error === 'string' && payload.error.trim()) {
        return payload.error;
      }
    } catch {
      // Ignore non-JSON error responses.
    }
    return fallback;
  }

  async function loadRecovery(
    options: { append?: boolean; silent?: boolean } = {},
  ) {
    const { append = false, silent = false } = options;
    const sequence = ++requestSequence;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;

    if (append) {
      loadingMore = true;
    } else if (!silent) {
      loading = true;
      statusAnnouncement = `Loading ${reasonFilterLabel(selectedReason).toLowerCase()} recovery articles.`;
    }
    errorMessage = '';

    try {
      if (navigator.onLine === false && !append) {
        if (await loadCachedRecoveryFallback()) return;
      }
      const params = new SvelteURLSearchParams({
        limit: String(PAGE_LIMIT),
        reason: selectedReason,
      });
      if (selectedFeedId) params.set('feedId', selectedFeedId);
      if (appliedQuery.trim()) params.set('q', appliedQuery.trim());
      if (append && nextCursor) params.set('cursor', nextCursor);

      const signal =
        typeof AbortSignal !== 'undefined' && 'any' in AbortSignal
          ? AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)])
          : controller.signal;

      const response = await fetch(`/api/article-state/recovery?${params}`, {
        signal,
      });
      if (!response.ok) {
        const message = await responseErrorMessage(
          response,
          'Recovery is unavailable right now.',
        );
        const httpError = new Error(message);
        (httpError as Error & { isHttpError?: boolean }).isHttpError = true;
        throw httpError;
      }

      const payload = (await response.json()) as {
        articles?: RecoveryArticle[];
        nextCursor?: string | null;
        reasonCounts?: Partial<RecoveryReasonCounts>;
        feeds?: RecoveryFeedOption[];
      };
      if (sequence !== requestSequence) return;

      offlineFallback = false;
      const incoming = payload.articles || [];
      if (append) {
        const existingIds = new SvelteSet(articles.map((item) => item.id));
        const deduped = incoming.filter((item) => !existingIds.has(item.id));
        articles = [...articles, ...deduped];
      } else {
        articles = incoming;
      }
      nextCursor = payload.nextCursor ?? null;
      if (append) {
        writeRecoveryReaderQueue();
      }
      if (payload.reasonCounts) {
        reasonCounts = {
          actionable: Number(payload.reasonCounts.actionable || 0),
          all: Number(payload.reasonCounts.all || 0),
          preference_model: Number(payload.reasonCounts.preference_model || 0),
          manual_hide: Number(payload.reasonCounts.manual_hide || 0),
          rejected: Number(payload.reasonCounts.rejected || 0),
          hide_on_open: Number(payload.reasonCounts.hide_on_open || 0),
        };
      }
      if (Array.isArray(payload.feeds)) {
        feeds = payload.feeds;
      }
      if (!silent) {
        statusAnnouncement = buildLoadedAnnouncement(articles.length, false);
      }
    } catch (error) {
      if (controller.signal.aborted || sequence !== requestSequence) return;
      const isHttpError = Boolean(
        error &&
        typeof error === 'object' &&
        'isHttpError' in error &&
        (error as { isHttpError?: boolean }).isHttpError,
      );
      if (!append && !isHttpError && (await loadCachedRecoveryFallback())) {
        return;
      }
      errorMessage =
        error instanceof Error ? error.message : 'Recovery failed.';
      statusAnnouncement = errorMessage;
    } finally {
      if (sequence === requestSequence) {
        loading = false;
        loadingMore = false;
      }
    }
  }

  function resetPaginationAndSelection() {
    nextCursor = null;
    selectedIds.clear();
  }

  function handleReasonChange(nextReason: RecoveryReasonFilter) {
    if (selectedReason === nextReason && !loading && !errorMessage) return;
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    appliedQuery = searchInput.trim();
    selectedReason = nextReason;
    resetPaginationAndSelection();
    void syncUrlFilters();
    void loadRecovery();
  }

  function handleFeedChange(nextFeedId: string) {
    if (selectedFeedId === nextFeedId && !loading && !errorMessage) return;
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    appliedQuery = searchInput.trim();
    selectedFeedId = nextFeedId;
    resetPaginationAndSelection();
    void syncUrlFilters();
    void loadRecovery();
  }

  function applySearchNow(nextRawQuery: string) {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    const trimmed = nextRawQuery.trim();
    if (trimmed === appliedQuery && !errorMessage) return;
    appliedQuery = trimmed;
    resetPaginationAndSelection();
    void syncUrlFilters();
    void loadRecovery();
  }

  function handleSearchInput(value: string) {
    searchInput = value;
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
    }
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null;
      applySearchNow(searchInput);
    }, 250);
  }

  function clearSearch() {
    searchInput = '';
    applySearchNow('');
  }

  function resetAllFilters() {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    selectedReason = 'actionable';
    selectedFeedId = '';
    searchInput = '';
    appliedQuery = '';
    resetPaginationAndSelection();
    void syncUrlFilters();
    void loadRecovery();
  }

  function toggleRowSelection(articleId: string) {
    if (selectedIds.has(articleId)) {
      selectedIds.delete(articleId);
      return;
    }
    if (selectedIds.size >= MAX_BATCH_RESTORE) {
      addToast(
        `Select up to ${MAX_BATCH_RESTORE} articles per restore`,
        'info',
      );
      return;
    }
    selectedIds.add(articleId);
  }

  function toggleSelectAllLoaded() {
    if (allSelectableSelected) {
      selectedIds.clear();
      statusAnnouncement = 'Cleared selection.';
      return;
    }
    selectedIds.clear();
    for (const article of selectableArticles) {
      selectedIds.add(article.id);
    }
    statusAnnouncement = `Selected ${selectedIds.size} ${selectedIds.size === 1 ? 'article' : 'articles'}.`;
  }

  function adjustLocalCounts(
    items: RecoveryArticle[],
    direction: -1 | 1,
  ): void {
    const nextCounts = { ...reasonCounts };
    const feedDeltas: Record<string, number> = Object.create(null);

    for (const item of items) {
      const reason = effectiveHideReason(item);
      nextCounts[reason] = Math.max(0, nextCounts[reason] + direction);
      nextCounts.all = Math.max(0, nextCounts.all + direction);
      if (reason !== 'hide_on_open') {
        nextCounts.actionable = Math.max(0, nextCounts.actionable + direction);
      }
      if (item.feedId) {
        feedDeltas[item.feedId] = (feedDeltas[item.feedId] || 0) + direction;
      }
    }
    reasonCounts = nextCounts;

    if (Object.keys(feedDeltas).length > 0) {
      feeds = feeds.map((feed) =>
        feedDeltas[feed.id]
          ? { ...feed, count: Math.max(0, feed.count + feedDeltas[feed.id]) }
          : feed,
      );
    }
  }

  function compareRecoveryOrder(
    left: RecoveryArticle,
    right: RecoveryArticle,
  ): number {
    const leftTime = left.stateChangedAt ?? 0;
    const rightTime = right.stateChangedAt ?? 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return right.id.localeCompare(left.id);
  }

  async function openRecoveryArticle(
    event: MouseEvent,
    article: RecoveryArticle,
  ) {
    writeRecoveryReaderQueue();
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    if ((offlineFallback || navigator.onLine === false) && openCachedArticle) {
      event.preventDefault();
      const cached =
        article.cached ??
        (await getCachedArticles(offlineScope())
          .then((list) => list.find((item) => item.id === article.id))
          .catch(() => undefined));
      await openCachedArticle(
        cached ?? {
          id: article.id,
          title: article.title,
          url: article.url,
          feed_id: article.feedId,
          feed_title: article.feedTitle,
          read: article.read,
          saved: article.saved,
          hidden: article.hidden,
          thumbs_down: article.thumbsDown,
        },
      );
    }
  }

  async function removeArticlesAndRefocus(
    removedArticles: RecoveryArticle[],
    trigger: HTMLElement | null,
    hadFocusAtStart: boolean,
  ) {
    if (removedArticles.length === 0) return;
    const removedSet = new SvelteSet(removedArticles.map((item) => item.id));
    const firstIndex = articles.findIndex((item) => removedSet.has(item.id));
    const focusLostOrOnTrigger =
      hadFocusAtStart ||
      (trigger !== null && document.activeElement === trigger) ||
      document.activeElement === document.body;

    for (const id of removedSet) {
      selectedIds.delete(id);
    }
    articles = articles.filter((item) => !removedSet.has(item.id));
    adjustLocalCounts(removedArticles, -1);

    await tick();
    if (
      focusLostOrOnTrigger &&
      (document.activeElement === document.body ||
        document.activeElement === trigger ||
        (trigger instanceof HTMLButtonElement && trigger.disabled))
    ) {
      const neighborIndex = Math.max(
        0,
        Math.min(firstIndex >= 0 ? firstIndex : 0, articles.length - 1),
      );
      const neighbor = articles[neighborIndex];
      const nextFocusTarget = neighbor
        ? document.getElementById(`restore-${neighbor.id}`)
        : heading;
      nextFocusTarget?.focus();
    }
  }

  async function undoRestoreOperation(
    operationId: string,
    snapshotArticles: RecoveryArticle[],
    restoreFilters: {
      reason: RecoveryReasonFilter;
      feedId: string;
      query: string;
    },
  ) {
    try {
      const undoRes = await fetchWithCsrf('/api/article-state/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId }),
      });
      if (!undoRes.ok) {
        throw new Error('Could not undo this restore.');
      }
      const outcome = (await undoRes.json()) as {
        restoredArticleIds?: string[];
        conflicts?: string[];
      };
      const revertedIds = new SvelteSet(outcome.restoredArticleIds || []);
      if (revertedIds.size === 0) {
        addToast(
          outcome.conflicts?.length
            ? 'Article state changed since this restore'
            : 'Restore was already undone',
          'warning',
        );
        return;
      }

      const filtersChanged =
        selectedReason !== restoreFilters.reason ||
        selectedFeedId !== restoreFilters.feedId ||
        appliedQuery.trim() !== restoreFilters.query;
      if (filtersChanged) {
        selectedIds.clear();
        await loadRecovery({ silent: true });
      } else {
        const revertedItems = snapshotArticles.filter((item) =>
          revertedIds.has(item.id),
        );
        const existingIds = new SvelteSet(articles.map((item) => item.id));
        const merged = [
          ...articles,
          ...revertedItems.filter((item) => !existingIds.has(item.id)),
        ].sort(compareRecoveryOrder);
        articles = merged;
        adjustLocalCounts(revertedItems, 1);

        if (!nextCursor) {
          void loadRecovery({ silent: true });
        }
      }

      void invalidate('app:reader-counts');

      const count = revertedIds.size;
      statusAnnouncement =
        count === 1
          ? 'Restore undone.'
          : `Undid restore for ${count} articles.`;
      if (outcome.conflicts?.length) {
        addToast(
          `Undid ${count} ${count === 1 ? 'restore' : 'restores'} (${outcome.conflicts.length} changed meanwhile)`,
          'warning',
        );
      } else {
        addToast(
          count === 1
            ? 'Restore undone'
            : `Undid restore for ${count} articles`,
          'success',
        );
      }
    } catch {
      addToast('Could not undo this restore', 'error');
    }
  }

  async function performRestore(
    targetArticles: RecoveryArticle[],
    trigger: HTMLButtonElement | null,
    isBatch: boolean,
  ) {
    const pendingArticles = targetArticles
      .filter((item) => !restoring[item.id])
      .slice(0, MAX_BATCH_RESTORE);
    if (pendingArticles.length === 0) return;

    const targetIds = pendingArticles.map((item) => item.id);
    const restoreFilters = {
      reason: selectedReason,
      feedId: selectedFeedId,
      query: appliedQuery.trim(),
    };
    const hadFocusAtStart =
      trigger !== null && document.activeElement === trigger;

    if (isBatch) {
      if (batchRestoring) return;
      batchRestoring = true;
    }
    const nextRestoring = { ...restoring };
    for (const id of targetIds) {
      nextRestoring[id] = true;
    }
    restoring = nextRestoring;

    const clearPending = () => {
      if (isBatch) {
        batchRestoring = false;
      }
      const cleaned = { ...restoring };
      for (const id of targetIds) {
        delete cleaned[id];
      }
      restoring = cleaned;
    };

    const queueOfflineRestore = async () => {
      const scope = offlineScope();
      for (const id of targetIds) {
        await enqueueOfflineMutation(scope, {
          articleId: id,
          type: 'restore',
        });
      }
      clearPending();
      await removeArticlesAndRefocus(pendingArticles, trigger, hadFocusAtStart);
      statusAnnouncement =
        targetIds.length === 1
          ? 'Queued 1 article restore for sync.'
          : `Queued ${targetIds.length} article restores for sync.`;
      addToast(
        targetIds.length === 1
          ? 'Restore queued — will sync when you’re online'
          : `${targetIds.length} restores queued — will sync when you’re online`,
        'info',
      );
    };

    try {
      if (navigator.onLine === false || offlineFallback) {
        await queueOfflineRestore();
        return;
      }

      const response = await fetchWithCsrf('/api/article-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          articleIds: targetIds,
          action: 'restore',
        }),
      });
      if (!response.ok) {
        const message = await responseErrorMessage(
          response,
          targetIds.length === 1
            ? 'Could not restore this article.'
            : 'Could not restore selected articles.',
        );
        const httpError = new Error(message);
        (httpError as Error & { isHttpError?: boolean }).isHttpError = true;
        throw httpError;
      }

      const result = (await response.json()) as {
        operationId?: string;
        changes?: Array<{ articleId: string; changed: boolean }>;
      };

      const scope = offlineScope();
      for (const id of targetIds) {
        void applyMutationToCachedArticle(scope, id, 'restore').catch(
          () => undefined,
        );
      }
      void invalidate('app:reader-counts');

      const snapshotArticles = pendingArticles.map((item) => ({ ...item }));
      clearPending();
      await removeArticlesAndRefocus(pendingArticles, trigger, hadFocusAtStart);

      const count = targetIds.length;
      statusAnnouncement =
        count === 1
          ? 'Restored 1 article to your feed.'
          : `Restored ${count} articles to your feed.`;

      const toastLabel =
        count === 1
          ? 'Article restored to your feed'
          : `${count} articles restored to your feed`;

      const operationId = result.operationId;
      const anyChanged =
        !result.changes || result.changes.some((change) => change.changed);
      if (operationId && anyChanged) {
        addToast(toastLabel, 'success', 5000, {
          label: 'Undo',
          run: async () => {
            await undoRestoreOperation(
              operationId,
              snapshotArticles,
              restoreFilters,
            );
          },
        });
      } else {
        addToast(toastLabel, 'success');
      }
    } catch (error) {
      if (
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === 'TimeoutError')
      ) {
        try {
          await queueOfflineRestore();
          return;
        } catch {
          // Fall through to error toast below.
        }
      }
      addToast(
        error instanceof Error ? error.message : 'Restore failed',
        'error',
      );
    } finally {
      clearPending();
    }
  }

  async function restoreSingle(
    article: RecoveryArticle,
    trigger: HTMLButtonElement,
  ) {
    await performRestore([article], trigger, false);
  }

  async function restoreSelected(trigger: HTMLButtonElement) {
    const chosen = articles
      .filter((article) => selectedIds.has(article.id))
      .slice(0, MAX_BATCH_RESTORE);
    await performRestore(chosen, trigger, true);
  }

  function relativeTime(value?: number | null): string {
    if (!value) return 'Previously';
    const days = Math.floor((Date.now() - value) / 86_400_000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return `${days} days ago`;
  }

  onMount(() => {
    parseInitialFiltersFromUrl();
    void loadRecovery();
    const handleOfflineArticleUpdated = (event: Event) => {
      const updated = (event as CustomEvent<OfflineArticle | undefined>).detail;
      if (!updated?.id) return;
      if (!updated.hidden && !updated.thumbs_down) {
        selectedIds.delete(updated.id);
        articles = articles.filter((item) => item.id !== updated.id);
      }
    };
    window.addEventListener(
      'feed-me-maybe:offline-article-updated',
      handleOfflineArticleUpdated,
    );
    return () => {
      window.removeEventListener(
        'feed-me-maybe:offline-article-updated',
        handleOfflineArticleUpdated,
      );
    };
  });

  onDestroy(() => {
    activeController?.abort();
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
    }
  });
</script>

<svelte:head>
  <title>Recovery · Feed Me Maybe</title>
  <meta
    name="description"
    content="Audit auto-hidden stories, filter by reason or source, and restore articles in bulk."
  />
</svelte:head>

<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
  {statusAnnouncement}
</p>

<div class="mx-auto max-w-5xl">
  <div class="mb-6">
    <p class="eyebrow text-secondary-300">Review hidden and rejected</p>
    <h1 class="section-title" bind:this={heading} tabindex="-1">Recovery</h1>
    <p class="section-subtitle">
      Audit auto-hidden false positives, search muted stories, and restore items
      individually or in bulk.
    </p>
  </div>

  <!-- Filter & Search Controls -->
  <section
    class="glass-card mb-6 space-y-4 p-4 md:p-5"
    aria-label="Recovery filters and search"
  >
    <div class="flex flex-col gap-3 md:flex-row md:items-center">
      <form
        class="relative flex-1"
        onsubmit={(event) => {
          event.preventDefault();
          applySearchNow(searchInput);
        }}
      >
        <label class="sr-only" for="recovery-search">
          Search hidden and rejected articles
        </label>
        <svg
          aria-hidden="true"
          class="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-300"
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-4-4" />
        </svg>
        <input
          id="recovery-search"
          type="search"
          class="input glass-input h-11 w-full pl-10 {searchInput
            ? 'pr-24'
            : 'pr-4'} text-sm"
          placeholder="Search title, author, summary, content, feed, or category…"
          value={searchInput}
          oninput={(event) => handleSearchInput(event.currentTarget.value)}
          autocomplete="off"
        />
        {#if searchInput}
          <button
            type="button"
            class="btn preset-tonal absolute right-1.5 top-1.5 h-8 px-2.5 text-xs"
            onclick={clearSearch}
            aria-label="Clear recovery search"
          >
            Clear
          </button>
        {/if}
      </form>

      <div class="w-full md:w-64">
        <label class="sr-only" for="recovery-feed-filter">
          Filter recovery by source feed
        </label>
        <select
          id="recovery-feed-filter"
          class="select glass-input h-11 w-full text-sm"
          value={selectedFeedId}
          onchange={(event) => handleFeedChange(event.currentTarget.value)}
        >
          <option value="">All feeds</option>
          {#each feeds as feed (feed.id)}
            <option value={feed.id}>
              {feed.title || 'Untitled feed'}{!feed.enabled ? ' (Paused)' : ''} ({feed.count})
            </option>
          {/each}
        </select>
      </div>
    </div>

    <div
      class="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Filter by hide reason"
    >
      {#each REASON_OPTIONS as option (option.value)}
        {@const count = reasonCounts[option.value]}
        {@const isActive = selectedReason === option.value}
        <button
          type="button"
          data-reason-filter={option.value}
          class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition {isActive
            ? 'border-secondary-400/45 bg-secondary-500/20 text-secondary-100'
            : 'border-white/10 bg-white/5 text-surface-300 hover:border-white/20 hover:text-surface-100'}"
          aria-pressed={isActive}
          onclick={() => handleReasonChange(option.value)}
        >
          <span>{option.label}</span>
          <span
            class="rounded-full px-1.5 py-0.5 text-[11px] leading-none {isActive
              ? 'bg-secondary-400/25 text-secondary-100'
              : 'bg-white/10 text-surface-300'}"
          >
            {count}
          </span>
        </button>
      {/each}
    </div>
  </section>

  {#if loading}
    <div
      class="glass-card flex min-h-48 items-center justify-center p-8"
      aria-busy="true"
      aria-label="Loading recovery list"
    >
      <div
        class="h-8 w-8 animate-spin rounded-full border-2 border-secondary-400 border-t-transparent"
      ></div>
    </div>
  {:else if errorMessage}
    <div class="glass-card p-8 text-center">
      <p class="text-error-300" role="alert">{errorMessage}</p>
      <button
        type="button"
        class="btn preset-tonal mt-4"
        onclick={() => void loadRecovery()}>Try again</button
      >
    </div>
  {:else if articles.length === 0}
    <div class="glass-card p-10 text-center">
      <p class="text-lg font-semibold text-surface-100" role="status">
        {#if appliedQuery || selectedFeedId}
          No matching recovery articles
        {:else if selectedReason === 'actionable' && reasonCounts.hide_on_open > 0}
          No actionable hidden or rejected articles
        {:else}
          No hidden or rejected articles
        {/if}
      </p>
      <p class="section-subtitle mt-2">
        {#if appliedQuery || selectedFeedId}
          Try adjusting your search query, feed filter, or hide reason.
        {:else if selectedReason === 'actionable' && reasonCounts.hide_on_open > 0}
          {reasonCounts.hide_on_open}
          {reasonCounts.hide_on_open === 1 ? 'article was' : 'articles were'}
          hidden automatically after opening.
        {:else}
          Articles you restore will appear in your feeds again.
        {/if}
      </p>
      {#if appliedQuery || selectedFeedId || (selectedReason !== 'actionable' && selectedReason !== 'all')}
        <div class="mt-5 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            class="btn preset-tonal"
            onclick={resetAllFilters}
          >
            Reset filters
          </button>
          {#if selectedReason === 'actionable' && reasonCounts.hide_on_open > 0}
            <button
              type="button"
              class="btn preset-filled-secondary-500"
              onclick={() => handleReasonChange('hide_on_open')}
            >
              Show hidden on open ({reasonCounts.hide_on_open})
            </button>
          {/if}
        </div>
      {:else if selectedReason === 'actionable' && reasonCounts.hide_on_open > 0}
        <div class="mt-5 flex justify-center">
          <button
            type="button"
            class="btn preset-tonal"
            onclick={() => handleReasonChange('hide_on_open')}
          >
            Show hidden on open ({reasonCounts.hide_on_open})
          </button>
        </div>
      {/if}
    </div>
  {:else}
    <!-- Batch Selection & Restore Bar -->
    <div
      class="glass-card mb-3 flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-5"
      role="region"
      aria-label="Batch selection actions"
    >
      <div class="flex flex-wrap items-center gap-3">
        <label
          class="inline-flex cursor-pointer items-center gap-2.5 text-sm font-medium text-surface-100"
          for="select-all-recovery"
        >
          <input
            id="select-all-recovery"
            type="checkbox"
            class="checkbox h-4 w-4"
            checked={allSelectableSelected}
            use:setIndeterminate={partiallySelected}
            onchange={toggleSelectAllLoaded}
            disabled={batchRestoring}
          />
          <span>
            {#if articles.length > MAX_BATCH_RESTORE}
              Select first {MAX_BATCH_RESTORE} loaded
            {:else}
              Select all loaded ({selectableArticles.length})
            {/if}
          </span>
        </label>
        {#if selectedCount > 0}
          <span class="text-xs text-surface-300">
            {selectedCount} selected{#if selectedCount >= MAX_BATCH_RESTORE}
              (limit reached){/if}
          </span>
          <button
            type="button"
            class="text-xs text-secondary-300 underline underline-offset-2 hover:text-secondary-200"
            onclick={() => {
              selectedIds.clear();
              statusAnnouncement = 'Cleared selection.';
            }}
            disabled={batchRestoring}
          >
            Clear
          </button>
        {/if}
      </div>

      <button
        id="batch-restore-button"
        type="button"
        class="btn preset-filled-secondary-500 text-sm"
        disabled={selectedCount === 0 || batchRestoring}
        onclick={(event) => void restoreSelected(event.currentTarget)}
      >
        {#if batchRestoring}
          Restoring {selectedCount}…
        {:else if selectedCount > 0}
          Restore selected ({selectedCount})
        {:else}
          Restore selected
        {/if}
      </button>
    </div>

    <div class="space-y-3">
      {#each articles as article (article.id)}
        {@const reason = effectiveHideReason(article)}
        {@const badge = reasonBadge(reason)}
        {@const isSelected = selectedIds.has(article.id)}
        {@const isRowPending = Boolean(restoring[article.id]) || batchRestoring}
        <article
          class="glass-card flex flex-col gap-4 p-4 transition md:flex-row md:items-center md:justify-between md:p-5 {isSelected
            ? 'border-secondary-400/40 bg-secondary-500/[0.06]'
            : ''}"
        >
          <div class="flex min-w-0 items-start gap-3.5">
            <div class="pt-0.5">
              <input
                id="select-{article.id}"
                type="checkbox"
                class="checkbox h-4 w-4"
                checked={isSelected}
                disabled={isRowPending ||
                  (!isSelected && selectedCount >= MAX_BATCH_RESTORE)}
                aria-label="Select {article.title}"
                onchange={() => toggleRowSelection(article.id)}
              />
            </div>
            <div class="min-w-0 flex-1">
              <div
                class="mb-2 flex flex-wrap items-center gap-2 text-xs text-surface-300"
              >
                <span
                  data-hide-reason={reason}
                  class="rounded-full px-2.5 py-0.5 font-medium {badge.classes}"
                >
                  {badge.label}
                </span>
                <span>{article.feedTitle || 'Unknown source'}</span>
                <span>·</span>
                <span>{relativeTime(article.stateChangedAt)}</span>
              </div>
              <a
                id="recovery-title-{article.id}"
                class="block font-semibold text-surface-100 no-underline transition hover:text-primary-300"
                href={recoveryArticleHref(article.id)}
                onauxclick={(e) => {
                  if (e.button === 1) writeRecoveryReaderQueue();
                }}
                onclick={(e) => void openRecoveryArticle(e, article)}
                >{article.title}</a
              >
            </div>
          </div>

          <div class="flex shrink-0 items-center gap-2 pl-7 md:pl-0">
            <a
              class="btn preset-tonal no-underline"
              href={recoveryArticleHref(article.id)}
              onauxclick={(e) => {
                if (e.button === 1) writeRecoveryReaderQueue();
              }}
              onclick={(e) => void openRecoveryArticle(e, article)}
              aria-label="Review {article.title}">Review</a
            >
            <button
              type="button"
              class="btn preset-filled-secondary-500"
              id="restore-{article.id}"
              aria-label={restoring[article.id]
                ? `Restoring ${article.title}`
                : `Restore ${article.title}`}
              onclick={(event) =>
                void restoreSingle(article, event.currentTarget)}
              disabled={isRowPending}
              >{restoring[article.id] ? 'Restoring…' : 'Restore'}</button
            >
          </div>
        </article>
      {/each}
    </div>

    {#if nextCursor}
      <div class="flex justify-center py-8">
        <button
          type="button"
          class="btn preset-tonal"
          disabled={loadingMore || batchRestoring}
          onclick={() => void loadRecovery({ append: true })}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      </div>
    {/if}
  {/if}
</div>
