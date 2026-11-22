<script lang="ts">
  import { tick } from 'svelte';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { goto } from '$app/navigation';
  import { page as pageStore } from '$app/state';
  import ArticleList from '#lib/components/ArticleList.svelte';
  import { fetchWithCsrf } from '#lib/client/csrf.ts';
  import { canTriggerSingleKeyShortcut } from '#lib/utils/keyboard-shortcuts.ts';
  import { invalidateReaderCounts } from '#lib/client/triage.ts';
  import {
    getCachedArticles,
    matchesOfflineVisibility,
  } from '#lib/offline/index.ts';
  import type { ReaderQueuePagination } from '#lib/reader-queue.ts';

  type Article = {
    id: string;
    feed_id?: string | null;
    url: string;
    title: string;
    summary?: string | null;
    image_url?: string | null;
    published_at?: number | null;
    fetched_at?: number | null;
    feed_title?: string | null;
    feed_title_highlight?: string | null;
    title_highlight?: string | null;
    summary_highlight?: string | null;
    content_highlight?: string | null;
    feed_open_mode?: string | null;
    feed_url?: string | null;
    saved?: boolean | null;
    read?: boolean | null;
    hidden?: boolean | null;
    thumbs_up?: boolean | null;
    thumbs_down?: boolean | null;
  };

  type SearchSort = 'relevance' | 'recent';

  type SavedSearchItem = {
    id: string;
    name: string;
    query: string;
    sort: SearchSort;
    pinned: boolean;
    unreadCount: number;
    totalCount: number;
    updatedAt?: number;
  };

  type SearchResponse = {
    articles?: Article[];
    total?: number;
    totalArticles?: number;
    nextCursor?: string | null;
    sort?: SearchSort;
  };

  const FILTERS = [
    { value: 'all', label: 'Everything', operator: '' },
    { value: 'unread', label: 'Unread', operator: 'is:unread' },
    { value: 'saved', label: 'Saved', operator: 'is:saved' },
    { value: 'read', label: 'Read', operator: 'is:read' },
    { value: 'hidden', label: 'Hidden', operator: 'is:hidden' },
    { value: 'rejected', label: 'Rejected', operator: 'is:rejected' },
  ] as const;

  const SORT_OPTIONS: Array<{ value: SearchSort; label: string }> = [
    { value: 'relevance', label: 'Relevance' },
    { value: 'recent', label: 'Newest' },
  ];

  function normalizeSavedSearchItem(
    raw: Partial<SavedSearchItem>,
  ): SavedSearchItem {
    return {
      id: String(raw.id || ''),
      name: String(raw.name || ''),
      query: String(raw.query || ''),
      sort: raw.sort === 'recent' ? 'recent' : 'relevance',
      pinned: Boolean(raw.pinned),
      unreadCount: Number(raw.unreadCount ?? 0),
      totalCount: Number(raw.totalCount ?? 0),
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : undefined,
    };
  }

  function sortSavedSearches(items: SavedSearchItem[]): SavedSearchItem[] {
    return [...items].sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        left.name.toLowerCase().localeCompare(right.name.toLowerCase()) ||
        (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
    );
  }

  function sortLabel(value: SearchSort): string {
    return value === 'recent' ? 'Newest' : 'Relevance';
  }

  const initialPinnedSearches = sortSavedSearches(
    (
      (pageStore.data.pinnedSearches as
        Partial<SavedSearchItem>[] | undefined) || []
    ).map(normalizeSavedSearchItem),
  );

  let query = $state('');
  let activeFilter = $state<(typeof FILTERS)[number]['value']>('all');
  let sort = $state<SearchSort>('relevance');
  let activeSearchQuery = $state('');
  let activeSearchSort = $state<SearchSort>('relevance');
  let preferredSort = $state<SearchSort>('relevance');
  let articles = $state<Article[]>([]);
  let total = $state(0);
  let nextCursor = $state<string | null>(null);
  let loading = $state(false);
  let loadingMore = $state(false);
  let searched = $state(false);
  let errorMessage = $state('');
  let statusAnnouncement = $state('');
  let savedSearches = $state<SavedSearchItem[]>(initialPinnedSearches);
  let showSaveSearch = $state(false);
  let showSavedSearchDetails = $state(initialPinnedSearches.length > 0);
  let autoExpandedSavedSearches = initialPinnedSearches.length > 0;
  let showFilters = $state(false);
  let saveSearchName = $state('');
  let savedSearchError = $state('');
  let savedSearchErrorId = $state<string | null>(null);
  let editingSavedSearchId = $state<string | null>(null);
  let editingSavedSearchName = $state('');
  let searchInputEl = $state<HTMLInputElement | null>(null);
  let editingSavedSearchQuery = $state('');
  let editingSavedSearchSort = $state<SearchSort>('relevance');
  let editingSavedSearchPinned = $state(false);
  let lastAppliedUrlSearch = $state<string | null>(null);
  let searchSequence = 0;
  let searchController: AbortController | null = null;
  let loadMoreController: AbortController | null = null;

  function toListArticle(article: Record<string, unknown>): Article {
    return {
      id: String(article.id),
      feed_id:
        (article.feedId as string | null) ??
        (article.feed_id as string | null) ??
        null,
      url: String(article.url || ''),
      title: String(article.title || 'Untitled'),
      summary: (article.summary as string | null) ?? null,
      image_url:
        (article.imageUrl as string | null) ??
        (article.image_url as string | null) ??
        null,
      published_at:
        (article.publishedAt as number | null) ??
        (article.published_at as number | null) ??
        null,
      fetched_at:
        (article.fetchedAt as number | null) ??
        (article.fetched_at as number | null) ??
        null,
      feed_title:
        (article.feedTitle as string | null) ??
        (article.feed_title as string | null) ??
        null,
      feed_title_highlight:
        (article.feedTitleHighlight as string | null) ??
        (article.feed_title_highlight as string | null) ??
        null,
      title_highlight:
        (article.titleHighlight as string | null) ??
        (article.title_highlight as string | null) ??
        null,
      summary_highlight:
        (article.summaryHighlight as string | null) ??
        (article.summary_highlight as string | null) ??
        null,
      content_highlight:
        (article.contentHighlight as string | null) ??
        (article.content_highlight as string | null) ??
        null,
      feed_open_mode:
        (article.feedOpenMode as string | null) ??
        (article.feed_open_mode as string | null) ??
        null,
      feed_url:
        (article.feedUrl as string | null) ??
        (article.feed_url as string | null) ??
        null,
      read: Boolean(article.read),
      saved: Boolean(article.saved),
      hidden: Boolean(article.hidden),
      thumbs_up: Boolean(article.thumbsUp),
      thumbs_down: Boolean(article.thumbsDown),
    };
  }

  const matchedFeeds = $derived.by(() => {
    const seen: Record<string, { id: string; title: string }> =
      Object.create(null);
    for (const article of articles) {
      const feedId = article.feed_id?.trim();
      if (!feedId || seen[feedId]) continue;
      seen[feedId] = {
        id: feedId,
        title: article.feed_title?.trim() || 'Feed',
      };
    }
    return Object.values(seen);
  });

  const activeSearchOrigin = $derived.by(() => {
    const params = new SvelteURLSearchParams();
    if (activeSearchQuery) params.set('q', activeSearchQuery);
    if (activeSearchSort === 'recent') params.set('sort', 'recent');
    return `/search${params.toString() ? `?${params}` : ''}`;
  });

  const searchQueuePagination = $derived<ReaderQueuePagination | null>(
    searched
      ? {
          kind: 'search',
          nextCursor,
          query: activeSearchQuery,
          sort: activeSearchSort,
        }
      : null,
  );

  function tokenizeSearchInput(raw: string): string[] {
    return raw.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  }

  function splitPrimaryStateFilter(rawQuery: string): {
    textQuery: string;
    primaryFilter: (typeof FILTERS)[number]['value'];
  } {
    const tokens = tokenizeSearchInput(rawQuery);
    const remaining: string[] = [];
    let primaryFilter: (typeof FILTERS)[number]['value'] | null = null;

    for (const token of tokens) {
      if (token.startsWith('"') && token.endsWith('"')) {
        remaining.push(token);
        continue;
      }
      const match = token.match(/^is:(unread|saved|read|hidden|rejected)$/i);
      if (match && primaryFilter === null) {
        primaryFilter =
          match[1].toLowerCase() as (typeof FILTERS)[number]['value'];
        continue;
      }
      remaining.push(token);
    }

    return {
      textQuery: remaining.join(' ').trim(),
      primaryFilter: primaryFilter ?? 'all',
    };
  }

  function operatorForFilter(value: string): string {
    return FILTERS.find((filter) => filter.value === value)?.operator || '';
  }

  function buildSearchQuery(): string {
    const operator = operatorForFilter(activeFilter);
    const trimmed = query.trim();
    if (!operator) return trimmed;
    const tokens = tokenizeSearchInput(trimmed);
    const alreadyPresent = tokens.some(
      (token) =>
        !(token.startsWith('"') && token.endsWith('"')) &&
        token.toLowerCase() === operator.toLowerCase(),
    );
    return alreadyPresent
      ? trimmed
      : [trimmed, operator].filter(Boolean).join(' ').trim();
  }

  async function responseError(
    response: Response,
    fallback: string,
  ): Promise<string> {
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload.error === 'string' && payload.error.trim()) {
        return payload.error;
      }
    } catch {
      // Use the local fallback when the server response is not JSON.
    }
    return fallback;
  }

  async function runSearch(updateUrl = true) {
    const sequence = ++searchSequence;
    searchController?.abort();
    loadMoreController?.abort();
    loadingMore = false;
    const controller = new AbortController();
    searchController = controller;
    loading = true;
    errorMessage = '';
    statusAnnouncement = 'Searching your library.';

    const searchText = query.trim();
    const searchFilter = activeFilter;
    const searchQuery = buildSearchQuery();
    const requestedSort = preferredSort;
    const params = new SvelteURLSearchParams();
    if (searchQuery) params.set('q', searchQuery);
    params.set('sort', requestedSort);

    let httpErrorMessage: string | null = null;
    try {
      const signal =
        typeof AbortSignal !== 'undefined' && 'any' in AbortSignal
          ? AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)])
          : controller.signal;
      const response = await fetch(`/api/search?${params.toString()}`, {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!response.ok) {
        httpErrorMessage = await responseError(
          response,
          'Search is unavailable right now.',
        );
        throw new Error(httpErrorMessage);
      }

      const payload = (await response.json()) as SearchResponse;
      if (sequence !== searchSequence) return;
      sort =
        payload.sort === 'recent' || payload.sort === 'relevance'
          ? payload.sort
          : requestedSort;
      articles = (payload.articles || []).map((article) =>
        toListArticle(article as unknown as Record<string, unknown>),
      );
      activeSearchQuery = searchQuery;
      activeSearchSort = sort;
      total = payload.total ?? payload.totalArticles ?? articles.length;
      nextCursor = payload.nextCursor ?? null;
      searched = true;
      showFilters = true;
      statusAnnouncement = `${total} ${total === 1 ? 'match' : 'matches'} found.`;

      if (updateUrl) {
        const target = `/search${params.toString() ? `?${params}` : ''}`;
        const current = `${pageStore.url.pathname}${pageStore.url.search}`;
        if (target !== current) {
          lastAppliedUrlSearch = params.toString() ? `?${params}` : '';
          await goto(target, { reset: false });
        }
      }
    } catch {
      if (controller.signal.aborted || sequence !== searchSequence) return;
      if (httpErrorMessage === null) {
        const cached = await getCachedArticles(
          String(pageStore.data.userId || 'admin'),
          { limit: 150 },
        ).catch(() => []);
        if (sequence !== searchSequence) return;
        const term = searchText.toLowerCase();
        const filtered = cached.filter((article) => {
          const visibilityFilter =
            searchFilter === 'hidden' || searchFilter === 'rejected'
              ? searchFilter
              : 'visible';
          const stateMatches =
            matchesOfflineVisibility(article, visibilityFilter) &&
            (searchFilter === 'all' ||
              (searchFilter === 'unread' && article.read !== true) ||
              (searchFilter === 'saved' && article.saved === true) ||
              (searchFilter === 'read' && article.read === true) ||
              (searchFilter === 'hidden' && article.hidden === true) ||
              (searchFilter === 'rejected' && article.thumbs_down === true));
          if (!stateMatches) return false;
          if (!term) return true;
          return `${article.title} ${article.summary || ''} ${article.content || ''} ${article.feed_title || ''}`
            .toLowerCase()
            .includes(term);
        });
        articles = filtered.map((article) =>
          toListArticle(article as unknown as Record<string, unknown>),
        );
        activeSearchQuery = searchQuery;
        sort = term ? requestedSort : 'recent';
        activeSearchSort = sort;
        total = articles.length;
        nextCursor = null;
        searched = true;
        showFilters = true;
        errorMessage = articles.length
          ? ''
          : 'No cached stories match this search.';
        statusAnnouncement = articles.length
          ? `${total} ${total === 1 ? 'cached match' : 'cached matches'} found.`
          : errorMessage;
      } else {
        errorMessage = httpErrorMessage;
        articles = [];
        total = 0;
        statusAnnouncement = '';
      }
    } finally {
      if (sequence === searchSequence) {
        searchController = null;
        loading = false;
      }
    }
  }

  async function loadMoreSearch() {
    if (!nextCursor || loadingMore) return;
    const sequence = searchSequence;
    const cursor = nextCursor;
    const controller = new AbortController();
    loadMoreController = controller;
    loadingMore = true;
    try {
      const params = new SvelteURLSearchParams({
        q: buildSearchQuery(),
        cursor,
        sort,
      });
      const signal =
        typeof AbortSignal !== 'undefined' && 'any' in AbortSignal
          ? AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)])
          : controller.signal;
      const response = await fetch(`/api/search?${params}`, { signal });
      if (!response.ok) {
        throw new Error(
          await responseError(response, 'Could not load more results.'),
        );
      }
      const payload = (await response.json()) as SearchResponse;
      if (sequence !== searchSequence) return;
      if (payload.sort === 'recent' || payload.sort === 'relevance') {
        sort = payload.sort;
      }
      articles = [
        ...articles,
        ...(payload.articles || []).map((article) =>
          toListArticle(article as unknown as Record<string, unknown>),
        ),
      ];
      nextCursor = payload.nextCursor ?? null;
      statusAnnouncement = `Loaded more results. ${articles.length} articles shown.`;
    } catch (error) {
      if (controller.signal.aborted || sequence !== searchSequence) return;
      errorMessage =
        error instanceof Error ? error.message : 'Could not load more results.';
      statusAnnouncement = '';
    } finally {
      if (sequence === searchSequence) {
        loadMoreController = null;
        loadingMore = false;
      }
    }
  }

  function canonicalizeQuery(rawQuery: string): string {
    const parsed = splitPrimaryStateFilter(rawQuery);
    const operator = operatorForFilter(parsed.primaryFilter);
    return [parsed.textQuery, operator].filter(Boolean).join(' ').trim();
  }

  function isSavedSearchCurrentlyLoaded(
    candidate: Pick<SavedSearchItem, 'query' | 'sort'>,
  ): boolean {
    if (!searched) return false;
    return (
      sort === candidate.sort &&
      canonicalizeQuery(buildSearchQuery()) ===
        canonicalizeQuery(candidate.query)
    );
  }

  async function loadSavedSearches() {
    try {
      const response = await fetch('/api/searches');
      if (response.ok) {
        const payload = (await response.json()) as {
          searches?: Partial<SavedSearchItem>[];
        };
        const next = sortSavedSearches(
          (payload.searches || []).map(normalizeSavedSearchItem),
        );
        savedSearches = next;
        if (next.length > 0 && !autoExpandedSavedSearches) {
          showSavedSearchDetails = true;
          autoExpandedSavedSearches = true;
        }
      }
    } catch {
      // Saved searches are an enhancement; the main search remains available.
    }
  }

  async function saveCurrentSearch() {
    const name = saveSearchName.trim();
    const searchQuery = buildSearchQuery();
    if (!name || !searchQuery) return;
    savedSearchError = '';
    savedSearchErrorId = null;
    try {
      const response = await fetchWithCsrf('/api/searches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          query: searchQuery,
          sort,
          pinned: true,
        }),
      });
      if (!response.ok) {
        throw new Error(
          await responseError(response, 'Could not save this search.'),
        );
      }
      const payload = (await response.json()) as {
        search?: Partial<SavedSearchItem>;
      };
      if (payload.search) {
        const created = normalizeSavedSearchItem(payload.search);
        savedSearches = sortSavedSearches([
          created,
          ...savedSearches.filter((item) => item.id !== created.id),
        ]);
        showSavedSearchDetails = true;
        autoExpandedSavedSearches = true;
        if (
          created.sort !== sort ||
          created.sort !== preferredSort ||
          pageStore.url.searchParams.get('sort') !== created.sort
        ) {
          preferredSort = created.sort;
          sort = created.sort;
          void runSearch(true);
        }
      }
      saveSearchName = '';
      showSaveSearch = false;
      savedSearchError = '';
      savedSearchErrorId = null;
      statusAnnouncement = 'Search saved.';
      invalidateReaderCounts();
    } catch (error) {
      savedSearchError =
        error instanceof Error ? error.message : 'Could not save this search.';
      savedSearchErrorId = null;
    }
  }

  function beginEditSavedSearch(search: SavedSearchItem) {
    editingSavedSearchId = search.id;
    editingSavedSearchName = search.name;
    editingSavedSearchQuery = search.query;
    editingSavedSearchSort = search.sort;
    editingSavedSearchPinned = search.pinned;
    savedSearchError = '';
    savedSearchErrorId = null;
    void tick().then(() =>
      document.getElementById(`saved-search-name-${search.id}`)?.focus(),
    );
  }

  async function updateSavedSearch(
    id: string,
    updates: {
      name?: string;
      query?: string;
      sort?: SearchSort;
      pinned?: boolean;
    },
  ): Promise<SavedSearchItem | null> {
    savedSearchError = '';
    savedSearchErrorId = id;
    try {
      const response = await fetchWithCsrf('/api/searches', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...updates }),
      });
      if (!response.ok) {
        throw new Error(
          await responseError(response, 'Could not update this saved search.'),
        );
      }
      const payload = (await response.json()) as {
        search?: Partial<SavedSearchItem>;
      };
      if (!payload.search)
        throw new Error('Saved search update was incomplete.');
      const updated = normalizeSavedSearchItem(payload.search);
      savedSearches = sortSavedSearches(
        savedSearches.map((search) => (search.id === id ? updated : search)),
      );
      savedSearchErrorId = null;
      statusAnnouncement = 'Saved search updated.';
      invalidateReaderCounts();
      return updated;
    } catch (error) {
      savedSearchError =
        error instanceof Error
          ? error.message
          : 'Could not update this saved search.';
      statusAnnouncement = '';
      return null;
    }
  }

  async function saveEditedSavedSearch(
    event: SubmitEvent,
    previous: SavedSearchItem,
  ) {
    event.preventDefault();
    const name = editingSavedSearchName.trim();
    const nextQuery = editingSavedSearchQuery.trim();
    if (!name) {
      savedSearchError = 'Enter a name for this saved search.';
      savedSearchErrorId = previous.id;
      return;
    }
    if (!nextQuery) {
      savedSearchError = 'Enter a search word or supported filter.';
      savedSearchErrorId = previous.id;
      return;
    }
    const wasLoaded = isSavedSearchCurrentlyLoaded(previous);
    const updated = await updateSavedSearch(previous.id, {
      name,
      query: nextQuery,
      sort: editingSavedSearchSort,
      pinned: editingSavedSearchPinned,
    });
    if (updated) {
      editingSavedSearchId = null;
      if (
        wasLoaded ||
        previous.query !== updated.query ||
        previous.sort !== updated.sort
      ) {
        loadSavedSearch(updated);
      }
      await tick();
      document.getElementById(`saved-search-edit-${previous.id}`)?.focus();
    }
  }

  async function deleteSavedSearch(id: string, name: string) {
    if (!confirm(`Delete the saved search “${name}”?`)) return;
    const index = savedSearches.findIndex((search) => search.id === id);
    savedSearchError = '';
    savedSearchErrorId = id;
    try {
      const response = await fetchWithCsrf('/api/searches', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) {
        throw new Error(
          await responseError(response, 'Could not delete this saved search.'),
        );
      }
      savedSearches = savedSearches.filter((search) => search.id !== id);
      if (editingSavedSearchId === id) {
        editingSavedSearchId = null;
      }
      savedSearchErrorId = null;
      statusAnnouncement = 'Saved search deleted.';
      invalidateReaderCounts();
      await tick();
      const openButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[data-saved-search-open]',
        ),
      );
      (
        openButtons[Math.min(index, openButtons.length - 1)] ||
        document.getElementById('search-query')
      )?.focus();
    } catch (error) {
      savedSearchError =
        error instanceof Error
          ? error.message
          : 'Could not delete this saved search.';
      statusAnnouncement = '';
    }
  }

  function loadSavedSearch(search: Pick<SavedSearchItem, 'query' | 'sort'>) {
    const parsed = splitPrimaryStateFilter(search.query);
    query = parsed.textQuery;
    activeFilter = parsed.primaryFilter;
    preferredSort = search.sort;
    sort = search.sort;
    showFilters = parsed.primaryFilter !== 'all' || showFilters;
    void runSearch();
  }

  function applyFilter(value: (typeof FILTERS)[number]['value']) {
    activeFilter = value;
    showFilters = true;
    void runSearch();
  }

  function applySort(nextSort: SearchSort) {
    preferredSort = nextSort;
    sort = nextSort;
    if (searched || buildSearchQuery()) {
      void runSearch();
    }
  }

  $effect(() => {
    const url = pageStore.url;
    if (url.pathname !== '/search') {
      searchSequence += 1;
      searchController?.abort();
      loadMoreController?.abort();
      loading = false;
      loadingMore = false;
      return;
    }
    const urlSearch = url.search;
    if (lastAppliedUrlSearch === urlSearch) return;
    lastAppliedUrlSearch = urlSearch;

    const urlSort: SearchSort =
      url.searchParams.get('sort') === 'recent' ? 'recent' : 'relevance';

    if (!url.searchParams.has('q')) {
      searchSequence += 1;
      searchController?.abort();
      loadMoreController?.abort();
      loading = false;
      loadingMore = false;
      query = '';
      activeFilter = 'all';
      preferredSort = urlSort;
      sort = urlSort;
      articles = [];
      total = 0;
      nextCursor = null;
      searched = false;
      errorMessage = '';
      statusAnnouncement = '';
      return;
    }

    const initialQuery = url.searchParams.get('q') || '';
    const parsed = splitPrimaryStateFilter(initialQuery);
    const nextQuery = parsed.textQuery;
    const nextFilter = parsed.primaryFilter;

    if (
      nextQuery === query &&
      nextFilter === activeFilter &&
      urlSort === preferredSort &&
      searched
    ) {
      return;
    }
    query = nextQuery;
    activeFilter = nextFilter;
    preferredSort = urlSort;
    sort = urlSort;
    showFilters = nextFilter !== 'all' || showFilters;
    void runSearch(false);
  });

  $effect(() => {
    void pageStore.data.pinnedSearches;
    void loadSavedSearches();
  });

  function toggleSaveSearchForm() {
    showSavedSearchDetails = true;
    showSaveSearch = !showSaveSearch;
  }

  $effect(() => {
    if (!showSavedSearchDetails) showSaveSearch = false;
  });

  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key !== '/' || !canTriggerSingleKeyShortcut(event)) return;
    event.preventDefault();
    searchInputEl?.focus();
  }
</script>

<svelte:window onkeydown={handleSearchKeydown} />

<svelte:head>
  <title>Search · Feed Me Maybe</title>
  <meta
    name="description"
    content="Search every story in your personal reading library."
  />
</svelte:head>

<div class="mx-auto max-w-7xl">
  <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
    {statusAnnouncement}
  </p>
  <div class="mb-8">
    <p class="eyebrow text-primary-300">Search your library</p>
    <h1 class="section-title">Search</h1>
    <p class="section-subtitle max-w-2xl">
      Find stories by title, source, summary, or full article text.
    </p>
    <details class="mt-3 max-w-2xl text-sm text-surface-300">
      <summary class="cursor-pointer text-primary-300">Search tips</summary>
      <p class="mt-2 leading-relaxed">
        Add filters such as
        <code class="rounded bg-white/10 px-1.5 py-0.5 text-primary-300"
          >is:unread</code
        >
        or
        <code class="rounded bg-white/10 px-1.5 py-0.5 text-primary-300"
          >after:2026-01-01</code
        >. You can also use a source name or ordinary words.
      </p>
    </details>
  </div>

  <form
    class="mb-5"
    onsubmit={(event) => {
      event.preventDefault();
      void runSearch();
    }}
  >
    <div class="relative block">
      <label class="sr-only" for="search-query">Search your library</label>
      <svg
        class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-primary-300"
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        ><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg
      >
      <input
        id="search-query"
        bind:this={searchInputEl}
        class="input glass-input h-14 w-full pl-12 pr-28 text-base md:text-lg"
        type="search"
        bind:value={query}
        placeholder="Search stories, sources, or filters"
        autocomplete="off"
      />
      <button
        class="btn preset-filled-primary-500 absolute right-2 top-2 h-10"
        type="submit"
        disabled={loading}>{loading ? 'Searching…' : 'Search'}</button
      >
    </div>
  </form>

  <div class="mb-8 flex flex-wrap items-center gap-2">
    <button
      type="button"
      class="btn preset-tonal h-9 px-3 text-xs"
      aria-expanded={showFilters}
      aria-controls="search-filter-group"
      onclick={() => (showFilters = !showFilters)}
      >{showFilters
        ? 'Hide filters'
        : 'Show filters'}{#if activeFilter !== 'all'}
        <span class="ml-1 text-primary-300"
          >· {FILTERS.find((filter) => filter.value === activeFilter)
            ?.label}</span
        >{/if}</button
    >
    <div
      id="search-filter-group"
      class="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Search filters"
      hidden={!showFilters}
    >
      {#each FILTERS as filter (filter.value)}
        <button
          type="button"
          class="rounded-full border px-3 py-1.5 text-xs font-semibold transition {activeFilter ===
          filter.value
            ? 'border-primary-400/40 bg-primary-500/15 text-primary-200'
            : 'border-white/10 bg-white/5 text-surface-300 hover:border-white/20 hover:text-surface-200'}"
          aria-pressed={activeFilter === filter.value}
          onclick={() => applyFilter(filter.value)}>{filter.label}</button
        >
      {/each}
    </div>
    <div class="feed-sort-tabs" role="group" aria-label="Sort search results">
      {#each SORT_OPTIONS as option (option.value)}
        <button
          type="button"
          class="feed-sort-tab"
          class:feed-sort-tab-active={sort === option.value}
          aria-pressed={sort === option.value}
          onclick={() => applySort(option.value)}>{option.label}</button
        >
      {/each}
    </div>
    {#if searched}
      <span class="ml-auto text-xs text-surface-500"
        >{total} {total === 1 ? 'match' : 'matches'}</span
      >
      {#if buildSearchQuery()}
        <button
          type="button"
          class="btn preset-tonal ml-2 h-8 px-3 text-xs"
          aria-expanded={showSaveSearch}
          aria-controls="save-search-form"
          onclick={toggleSaveSearchForm}>Save search</button
        >
      {/if}
    {/if}
  </div>

  {#if savedSearches.length > 0 || showSaveSearch || showSavedSearchDetails}
    <details
      class="mb-8 rounded-sm border border-white/10 bg-white/[0.03] p-4"
      aria-label="Saved searches"
      bind:open={showSavedSearchDetails}
    >
      <summary class="cursor-pointer text-sm font-semibold text-surface-100">
        Saved searches{#if savedSearches.length > 0}
          <span class="ml-1 text-xs font-normal text-surface-300"
            >({savedSearches.length})</span
          >{/if}
      </summary>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
        <form
          id="save-search-form"
          class="flex w-full gap-2 sm:w-auto"
          hidden={!showSaveSearch}
          onsubmit={(event) => {
            event.preventDefault();
            void saveCurrentSearch();
          }}
        >
          <label class="sr-only" for="saved-search-name"
            >Saved search name</label
          >
          <input
            id="saved-search-name"
            class="input glass-input h-9 w-full sm:w-48"
            bind:value={saveSearchName}
            placeholder="Name this search"
            maxlength="120"
            required
            aria-describedby={savedSearchError && savedSearchErrorId === null
              ? 'saved-search-error'
              : undefined}
          />
          <button
            type="submit"
            class="btn preset-filled-secondary-500 h-9"
            disabled={!saveSearchName.trim()}>Save</button
          >
        </form>
      </div>
      {#if savedSearchError && savedSearchErrorId === null}
        <p
          id="saved-search-error"
          class="mt-2 text-sm text-error-300"
          role="alert"
        >
          {savedSearchError}
        </p>
      {/if}
      {#if savedSearches.length > 0}
        <div class="mt-3 space-y-2">
          {#each savedSearches as savedSearch (savedSearch.id)}
            <div
              class="rounded-sm border border-white/10 bg-white/[0.03] p-3"
              data-saved-search-row={savedSearch.id}
            >
              {#if editingSavedSearchId === savedSearch.id}
                <form
                  class="space-y-3"
                  onsubmit={(event) =>
                    void saveEditedSavedSearch(event, savedSearch)}
                >
                  <div class="grid gap-3 sm:grid-cols-2">
                    <label class="block text-xs text-surface-200">
                      <span class="mb-1 block font-medium">Name</span>
                      <input
                        id="saved-search-name-{savedSearch.id}"
                        class="input glass-input h-9 w-full"
                        bind:value={editingSavedSearchName}
                        maxlength="120"
                        required
                        aria-invalid={savedSearchErrorId === savedSearch.id
                          ? 'true'
                          : undefined}
                        aria-describedby={savedSearchErrorId === savedSearch.id
                          ? `saved-search-error-${savedSearch.id}`
                          : undefined}
                      />
                    </label>
                    <label class="block text-xs text-surface-200">
                      <span class="mb-1 block font-medium">Query</span>
                      <input
                        id="saved-search-query-{savedSearch.id}"
                        class="input glass-input h-9 w-full font-mono text-xs"
                        bind:value={editingSavedSearchQuery}
                        maxlength="500"
                        required
                        aria-invalid={savedSearchErrorId === savedSearch.id
                          ? 'true'
                          : undefined}
                        aria-describedby={savedSearchErrorId === savedSearch.id
                          ? `saved-search-error-${savedSearch.id}`
                          : undefined}
                      />
                    </label>
                  </div>
                  <div class="flex flex-wrap items-center gap-3">
                    <label
                      class="inline-flex items-center gap-2 text-xs text-surface-200"
                      for="saved-search-sort-{savedSearch.id}"
                    >
                      <span class="font-medium">Sort</span>
                      <select
                        id="saved-search-sort-{savedSearch.id}"
                        class="select glass-input h-9 px-2.5 text-xs"
                        bind:value={editingSavedSearchSort}
                      >
                        {#each SORT_OPTIONS as option (option.value)}
                          <option value={option.value}>{option.label}</option>
                        {/each}
                      </select>
                    </label>
                    <label
                      class="inline-flex cursor-pointer items-center gap-2 text-xs text-surface-200"
                    >
                      <input
                        id="saved-search-pinned-{savedSearch.id}"
                        type="checkbox"
                        class="checkbox"
                        bind:checked={editingSavedSearchPinned}
                      />
                      <span>Pin to sidebar</span>
                    </label>
                    <div class="ml-auto flex flex-wrap items-center gap-2">
                      <button
                        type="submit"
                        class="btn preset-filled-secondary-500 h-9 px-3 text-xs"
                        disabled={!editingSavedSearchName.trim() ||
                          !editingSavedSearchQuery.trim()}>Save changes</button
                      >
                      <button
                        type="button"
                        class="btn preset-tonal h-9 px-3 text-xs"
                        onclick={() => {
                          editingSavedSearchId = null;
                          savedSearchError = '';
                          savedSearchErrorId = null;
                          void tick().then(() =>
                            document
                              .getElementById(
                                `saved-search-edit-${savedSearch.id}`,
                              )
                              ?.focus(),
                          );
                        }}>Cancel</button
                      >
                    </div>
                  </div>
                </form>
              {:else}
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div class="flex min-w-0 flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-saved-search-open={savedSearch.id}
                      class="rounded-full border px-3 py-1.5 text-left text-xs font-semibold transition {isSavedSearchCurrentlyLoaded(
                        savedSearch,
                      )
                        ? 'border-primary-400/40 bg-primary-500/15 text-primary-200'
                        : 'border-white/10 bg-white/5 text-surface-100 hover:border-secondary-400/40 hover:text-secondary-200'}"
                      onclick={() => loadSavedSearch(savedSearch)}
                      >{savedSearch.name}</button
                    >
                    <code
                      class="rounded bg-white/5 px-2 py-0.5 font-mono text-xs text-primary-200"
                      >{savedSearch.query}</code
                    >
                    <span
                      class="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-surface-200"
                      >{sortLabel(savedSearch.sort)}</span
                    >
                    <span
                      class={savedSearch.unreadCount > 0
                        ? 'rounded-full bg-primary-500/15 px-2.5 py-0.5 text-[11px] font-bold text-primary-300'
                        : 'rounded-full bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-surface-300'}
                      >{savedSearch.unreadCount} unread</span
                    >
                    <span class="text-xs text-surface-300"
                      >{savedSearch.totalCount}
                      {savedSearch.totalCount === 1 ? 'match' : 'matches'}</span
                    >
                  </div>
                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      class="btn preset-tonal h-8 px-3 text-xs"
                      aria-label={`Pin saved search ${savedSearch.name}`}
                      aria-pressed={savedSearch.pinned}
                      onclick={() =>
                        void updateSavedSearch(savedSearch.id, {
                          pinned: !savedSearch.pinned,
                        })}>{savedSearch.pinned ? 'Pinned' : 'Pin'}</button
                    >
                    <button
                      id="saved-search-edit-{savedSearch.id}"
                      type="button"
                      class="btn preset-tonal h-8 px-3 text-xs"
                      data-saved-search-edit={savedSearch.id}
                      aria-label={`Edit saved search ${savedSearch.name}`}
                      onclick={() => beginEditSavedSearch(savedSearch)}
                      >Edit</button
                    >
                    <button
                      type="button"
                      class="btn preset-tonal h-8 px-3 text-xs"
                      aria-label={`Delete saved search ${savedSearch.name}`}
                      onclick={() =>
                        void deleteSavedSearch(
                          savedSearch.id,
                          savedSearch.name,
                        )}>Delete</button
                    >
                  </div>
                </div>
              {/if}
              {#if savedSearchError && savedSearchErrorId === savedSearch.id}
                <p
                  id="saved-search-error-{savedSearch.id}"
                  class="mt-2 text-sm text-error-300"
                  role="alert"
                >
                  {savedSearchError}
                </p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </details>
  {/if}

  {#if errorMessage}
    <div class="glass-card p-8 text-center">
      <p class="text-lg font-semibold text-error-300" role="alert">
        {errorMessage}
      </p>
      <button
        class="btn preset-tonal mt-4"
        type="button"
        onclick={() => void runSearch()}>Try again</button
      >
    </div>
  {:else if loading}
    <div
      class="glass-card flex min-h-56 items-center justify-center p-8 text-center"
      aria-busy="true"
    >
      <div>
        <div
          class="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-primary-400 border-t-transparent"
        ></div>
        <p class="text-sm text-surface-300">Searching your library…</p>
      </div>
    </div>
  {:else if !searched}
    <div
      class="glass-card flex min-h-56 items-center justify-center p-8 text-center"
    >
      <div>
        <p class="text-lg font-semibold text-surface-100">
          Search your library
        </p>
        <p class="section-subtitle mt-2">
          Enter a word, source, or filter above to search your stories.
        </p>
      </div>
    </div>
  {:else}
    {#if matchedFeeds.length > 0}
      <div
        class="mb-4 flex flex-wrap items-center gap-2 text-xs text-surface-300"
        aria-label="Matching feeds"
      >
        <span class="font-semibold text-surface-200">Sources:</span>
        {#each matchedFeeds as feed (feed.id)}
          <a
            href="/feeds/{feed.id}"
            class="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-primary-200 no-underline transition hover:border-primary-400/40 hover:bg-primary-500/15"
          >
            {feed.title}
          </a>
        {/each}
      </div>
    {/if}
    <ArticleList
      bind:articles
      totalPages={1}
      showInfiniteScroll={false}
      queuePagination={searchQueuePagination}
      streamOrigin={activeSearchOrigin}
      emptyTitle={buildSearchQuery()
        ? 'No stories matched'
        : 'No stories found'}
      emptyMessage={buildSearchQuery()
        ? 'Try fewer words, a different source, or a wider date range.'
        : 'Search by title, source, or full text to find a story.'}
      emptyCtaHref="/"
      emptyCtaLabel="Return to the feed"
    />
    {#if nextCursor}
      <div class="flex justify-center py-8">
        <button
          type="button"
          class="btn preset-tonal"
          onclick={() => void loadMoreSearch()}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading…' : 'Load more results'}
        </button>
      </div>
    {/if}
  {/if}
</div>
