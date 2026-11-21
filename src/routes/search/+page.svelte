<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { page as pageStore } from '$app/state';
  import ArticleList from '#lib/components/ArticleList.svelte';
  import { fetchWithCsrf } from '#lib/client/csrf.ts';
  import {
    getCachedArticles,
    matchesOfflineVisibility,
  } from '#lib/offline/index.ts';

  type Article = {
    id: string;
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

  type SearchResponse = {
    articles?: Article[];
    total?: number;
    totalArticles?: number;
    nextCursor?: string | null;
  };

  const FILTERS = [
    { value: 'all', label: 'Everything', operator: '' },
    { value: 'unread', label: 'Unread', operator: 'is:unread' },
    { value: 'saved', label: 'Saved', operator: 'is:saved' },
    { value: 'read', label: 'Read', operator: 'is:read' },
    { value: 'hidden', label: 'Hidden', operator: 'is:hidden' },
    { value: 'rejected', label: 'Rejected', operator: 'is:rejected' },
  ] as const;

  let query = $state('');
  let activeFilter = $state<(typeof FILTERS)[number]['value']>('all');
  let articles = $state<Article[]>([]);
  let total = $state(0);
  let nextCursor = $state<string | null>(null);
  let loading = $state(false);
  let loadingMore = $state(false);
  let searched = $state(false);
  let errorMessage = $state('');
  let statusAnnouncement = $state('');
  let savedSearches = $state<
    Array<{ id: string; name: string; query: string; pinned: boolean }>
  >([]);
  let showSaveSearch = $state(false);
  let showSavedSearchDetails = $state(false);
  let showFilters = $state(false);
  let saveSearchName = $state('');
  let savedSearchError = $state('');
  let savedSearchErrorId = $state<string | null>(null);
  let editingSavedSearchId = $state<string | null>(null);
  let editingSavedSearchName = $state('');
  let lastAppliedUrlSearch = $state<string | null>(null);
  let searchSequence = 0;
  let searchController: AbortController | null = null;
  let loadMoreController: AbortController | null = null;

  function toListArticle(article: Record<string, unknown>): Article {
    return {
      id: String(article.id),
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

  function operatorForFilter(value: string): string {
    return FILTERS.find((filter) => filter.value === value)?.operator || '';
  }

  function buildSearchQuery(): string {
    const operator = operatorForFilter(activeFilter);
    return [query.trim(), operator].filter(Boolean).join(' ').trim();
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
    const searchQuery = [searchText, operatorForFilter(searchFilter)]
      .filter(Boolean)
      .join(' ')
      .trim();
    const params = new URLSearchParams();
    if (searchQuery) params.set('q', searchQuery);

    try {
      const response = await fetch(`/api/search?${params.toString()}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          await responseError(response, 'Search is unavailable right now.'),
        );
      }

      const payload = (await response.json()) as SearchResponse;
      if (sequence !== searchSequence) return;
      articles = (payload.articles || []).map((article) =>
        toListArticle(article as unknown as Record<string, unknown>),
      );
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
    } catch (error) {
      if (controller.signal.aborted || sequence !== searchSequence) return;
      if (navigator.onLine === false) {
        const cached = await getCachedArticles('admin', { limit: 150 });
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
        errorMessage =
          error instanceof Error ? error.message : 'Search failed.';
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
      const params = new URLSearchParams({
        q: buildSearchQuery(),
        cursor,
      });
      const response = await fetch(`/api/search?${params}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          await responseError(response, 'Could not load more results.'),
        );
      }
      const payload = (await response.json()) as SearchResponse;
      if (sequence !== searchSequence) return;
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

  async function loadSavedSearches() {
    try {
      const response = await fetch('/api/searches');
      if (response.ok) {
        const payload = (await response.json()) as {
          searches?: typeof savedSearches;
        };
        savedSearches = payload.searches || [];
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
        body: JSON.stringify({ name, query: searchQuery, pinned: true }),
      });
      if (!response.ok) {
        throw new Error(
          await responseError(response, 'Could not save this search.'),
        );
      }
      const payload = (await response.json()) as {
        search?: (typeof savedSearches)[number];
      };
      if (payload.search) {
        savedSearches = [payload.search, ...savedSearches].sort(
          (left, right) =>
            Number(right.pinned) - Number(left.pinned) ||
            left.name.localeCompare(right.name),
        );
      }
      saveSearchName = '';
      showSaveSearch = false;
      savedSearchError = '';
      savedSearchErrorId = null;
      statusAnnouncement = 'Search saved.';
    } catch (error) {
      savedSearchError =
        error instanceof Error ? error.message : 'Could not save this search.';
      savedSearchErrorId = null;
    }
  }

  function beginRenameSavedSearch(search: (typeof savedSearches)[number]) {
    editingSavedSearchId = search.id;
    editingSavedSearchName = search.name;
    savedSearchError = '';
    savedSearchErrorId = null;
    void tick().then(() =>
      document.getElementById(`saved-search-name-${search.id}`)?.focus(),
    );
  }

  async function updateSavedSearch(
    id: string,
    updates: { name?: string; pinned?: boolean },
  ): Promise<boolean> {
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
        search?: (typeof savedSearches)[number];
      };
      if (!payload.search)
        throw new Error('Saved search update was incomplete.');
      savedSearches = savedSearches
        .map((search) => (search.id === id ? payload.search! : search))
        .sort(
          (left, right) =>
            Number(right.pinned) - Number(left.pinned) ||
            left.name.localeCompare(right.name),
        );
      savedSearchErrorId = null;
      statusAnnouncement = 'Saved search updated.';
      return true;
    } catch (error) {
      savedSearchError =
        error instanceof Error
          ? error.message
          : 'Could not update this saved search.';
      statusAnnouncement = '';
      return false;
    }
  }

  async function renameSavedSearch(event: SubmitEvent, id: string) {
    event.preventDefault();
    const name = editingSavedSearchName.trim();
    if (!name) {
      savedSearchError = 'Enter a name for this saved search.';
      savedSearchErrorId = id;
      return;
    }
    if (await updateSavedSearch(id, { name })) {
      editingSavedSearchId = null;
      await tick();
      document.getElementById(`saved-search-rename-${id}`)?.focus();
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
      savedSearchErrorId = null;
      statusAnnouncement = 'Saved search deleted.';
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

  function loadSavedSearch(search: { query: string }) {
    const operator = search.query.match(
      /\bis:(unread|saved|read|hidden|rejected)\b/i,
    )?.[1];
    query = search.query
      .replace(/\bis:(unread|saved|read|hidden|rejected)\b/gi, '')
      .trim();
    activeFilter = operator
      ? (operator.toLowerCase() as typeof activeFilter)
      : 'all';
    void runSearch();
  }

  function applyFilter(value: (typeof FILTERS)[number]['value']) {
    activeFilter = value;
    showFilters = true;
    void runSearch();
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

    if (!url.searchParams.has('q')) {
      searchSequence += 1;
      searchController?.abort();
      loadMoreController?.abort();
      loading = false;
      loadingMore = false;
      query = '';
      activeFilter = 'all';
      articles = [];
      total = 0;
      nextCursor = null;
      searched = false;
      errorMessage = '';
      statusAnnouncement = '';
      return;
    }

    const initialQuery = url.searchParams.get('q') || '';
    const initialOperator = initialQuery.match(
      /\bis:(unread|saved|read|hidden|rejected)\b/i,
    )?.[1];
    const nextQuery = initialQuery
      .replace(/\bis:(unread|saved|read|hidden|rejected)\b/gi, '')
      .trim();
    const nextFilter = initialOperator
      ? (initialOperator.toLowerCase() as typeof activeFilter)
      : 'all';

    if (nextQuery === query && nextFilter === activeFilter) return;
    query = nextQuery;
    activeFilter = nextFilter;
    showFilters = nextFilter !== 'all' || showFilters;
    void runSearch(false);
  });

  onMount(() => {
    void loadSavedSearches();
  });

  function toggleSaveSearchForm() {
    showSavedSearchDetails = true;
    showSaveSearch = !showSaveSearch;
  }

  $effect(() => {
    if (!showSavedSearchDetails) showSaveSearch = false;
  });
</script>

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
    <label class="relative block">
      <span class="sr-only">Search your library</span>
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
    </label>
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
      {#each FILTERS as filter}
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
            <div class="rounded-sm border border-white/10 bg-white/[0.03] p-2">
              {#if editingSavedSearchId === savedSearch.id}
                <form
                  class="flex flex-wrap items-center gap-2"
                  onsubmit={(event) => renameSavedSearch(event, savedSearch.id)}
                >
                  <label
                    class="sr-only"
                    for="saved-search-name-{savedSearch.id}"
                    >Name for {savedSearch.name}</label
                  >
                  <input
                    id="saved-search-name-{savedSearch.id}"
                    class="input glass-input h-9 min-w-0 flex-1 sm:max-w-xs"
                    bind:value={editingSavedSearchName}
                    maxlength="120"
                    required
                    aria-invalid={savedSearchErrorId === savedSearch.id
                      ? 'true'
                      : undefined}
                    aria-describedby={savedSearchErrorId === savedSearch.id
                      ? 'saved-search-error-{savedSearch.id}'
                      : undefined}
                  />
                  <button
                    type="submit"
                    class="btn preset-filled-secondary-500 h-9 px-3 text-xs"
                    disabled={!editingSavedSearchName.trim()}>Save name</button
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
                            `saved-search-rename-${savedSearch.id}`,
                          )
                          ?.focus(),
                      );
                    }}>Cancel</button
                  >
                </form>
              {:else}
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-saved-search-open={savedSearch.id}
                    class="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-left text-xs text-surface-300 transition hover:border-secondary-400/40 hover:text-secondary-200"
                    onclick={() => loadSavedSearch(savedSearch)}
                    >{savedSearch.name}</button
                  >
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
                    id="saved-search-rename-{savedSearch.id}"
                    type="button"
                    class="btn preset-tonal h-8 px-3 text-xs"
                    data-saved-search-rename={savedSearch.id}
                    onclick={() => beginRenameSavedSearch(savedSearch)}
                    >Rename</button
                  >
                  <button
                    type="button"
                    class="btn preset-tonal h-8 px-3 text-xs"
                    onclick={() =>
                      void deleteSavedSearch(savedSearch.id, savedSearch.name)}
                    >Delete</button
                  >
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
    <ArticleList
      bind:articles
      totalPages={1}
      showInfiniteScroll={false}
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
