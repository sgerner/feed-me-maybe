<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page as pageStore } from '$app/stores';
  import ArticleList from '$lib/components/ArticleList.svelte';
  import { fetchWithCsrf } from '$lib/client/csrf';
  import { getCachedArticles } from '$lib/offline';

  type Article = {
    id: string;
    url: string;
    title: string;
    summary?: string | null;
    image_url?: string | null;
    published_at?: number | null;
    fetched_at?: number | null;
    feed_title?: string | null;
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
  let savedSearches = $state<
    Array<{ id: string; name: string; query: string; pinned: boolean }>
  >([]);
  let showSaveSearch = $state(false);
  let showFilters = $state(false);
  let saveSearchName = $state('');

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

  async function runSearch(updateUrl = true) {
    if (loading) return;
    loading = true;
    errorMessage = '';

    const searchQuery = buildSearchQuery();
    const params = new URLSearchParams();
    if (searchQuery) params.set('q', searchQuery);

    try {
      const response = await fetch(`/api/search?${params.toString()}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Search is unavailable right now.');

      const payload = (await response.json()) as SearchResponse;
      articles = (payload.articles || []).map((article) =>
        toListArticle(article as unknown as Record<string, unknown>),
      );
      total = payload.total ?? payload.totalArticles ?? articles.length;
      nextCursor = payload.nextCursor ?? null;
      searched = true;
      showFilters = true;

      if (updateUrl) {
        await goto(`/search${params.toString() ? `?${params}` : ''}`, {
          replaceState: true,
          keepFocus: true,
          noScroll: true,
        });
      }
    } catch (error) {
      if (navigator.onLine === false) {
        const cached = await getCachedArticles('admin', { limit: 150 });
        const term = query.trim().toLowerCase();
        const filtered = cached.filter((article) => {
          const stateMatches =
            activeFilter === 'all' ||
            (activeFilter === 'unread' && article.read !== true) ||
            (activeFilter === 'saved' && article.saved === true) ||
            (activeFilter === 'read' && article.read === true) ||
            (activeFilter === 'hidden' && article.hidden === true) ||
            (activeFilter === 'rejected' && article.thumbs_down === true);
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
      } else {
        errorMessage =
          error instanceof Error ? error.message : 'Search failed.';
        articles = [];
        total = 0;
      }
    } finally {
      loading = false;
    }
  }

  async function loadMoreSearch() {
    if (!nextCursor || loadingMore) return;
    loadingMore = true;
    try {
      const params = new URLSearchParams({
        q: buildSearchQuery(),
        cursor: nextCursor,
      });
      const response = await fetch(`/api/search?${params}`);
      if (!response.ok) throw new Error('Could not load more results.');
      const payload = (await response.json()) as SearchResponse;
      articles = [
        ...articles,
        ...(payload.articles || []).map((article) =>
          toListArticle(article as unknown as Record<string, unknown>),
        ),
      ];
      nextCursor = payload.nextCursor ?? null;
    } catch (error) {
      errorMessage =
        error instanceof Error ? error.message : 'Could not load more results.';
    } finally {
      loadingMore = false;
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
    try {
      const response = await fetchWithCsrf('/api/searches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, query: searchQuery, pinned: true }),
      });
      if (!response.ok) throw new Error('Could not save this search.');
      const payload = (await response.json()) as {
        search?: (typeof savedSearches)[number];
      };
      if (payload.search) savedSearches = [payload.search, ...savedSearches];
      saveSearchName = '';
      showSaveSearch = false;
    } catch (error) {
      errorMessage =
        error instanceof Error ? error.message : 'Could not save this search.';
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

  onMount(() => {
    const initialQuery = $pageStore.url.searchParams.get('q') || '';
    const initialOperator = initialQuery.match(
      /\bis:(unread|saved|read|hidden|rejected)\b/i,
    )?.[1];
    query = initialQuery
      .replace(/\bis:(unread|saved|read|hidden|rejected)\b/gi, '')
      .trim();
    if (initialOperator) {
      activeFilter = initialOperator.toLowerCase() as typeof activeFilter;
      showFilters = true;
    }
    if (initialQuery || initialOperator) void runSearch(false);
    void loadSavedSearches();
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
  <div class="mb-8">
    <p class="eyebrow text-primary-300">Search your library</p>
    <h1 class="section-title">Search</h1>
    <p class="section-subtitle max-w-2xl">
      Find stories by title, source, summary, or full article text.
    </p>
    <details class="mt-3 max-w-2xl text-sm text-surface-400">
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
      onclick={() => (showFilters = !showFilters)}
      >{showFilters
        ? 'Hide filters'
        : 'Show filters'}{#if activeFilter !== 'all'}
        <span class="ml-1 text-primary-300"
          >· {FILTERS.find((filter) => filter.value === activeFilter)
            ?.label}</span
        >{/if}</button
    >
    {#if showFilters}<div
        class="flex flex-wrap items-center gap-2"
        role="tablist"
        aria-label="Search filters"
      >
        {#each FILTERS as filter}
          <button
            type="button"
            class="rounded-full border px-3 py-1.5 text-xs font-semibold transition {activeFilter ===
            filter.value
              ? 'border-primary-400/40 bg-primary-500/15 text-primary-200'
              : 'border-white/10 bg-white/5 text-surface-400 hover:border-white/20 hover:text-surface-200'}"
            role="tab"
            aria-selected={activeFilter === filter.value}
            onclick={() => applyFilter(filter.value)}>{filter.label}</button
          >
        {/each}
      </div>{/if}
    {#if searched}
      <span class="ml-auto text-xs text-surface-500"
        >{total} {total === 1 ? 'match' : 'matches'}</span
      >
      {#if buildSearchQuery()}
        <button
          type="button"
          class="btn preset-tonal ml-2 h-8 px-3 text-xs"
          onclick={() => (showSaveSearch = !showSaveSearch)}>Save search</button
        >
      {/if}
    {/if}
  </div>

  {#if savedSearches.length > 0 || showSaveSearch}
    <details
      class="mb-8 rounded-sm border border-white/10 bg-white/[0.03] p-4"
      aria-label="Saved searches"
      open={showSaveSearch}
    >
      <summary class="cursor-pointer text-sm font-semibold text-surface-100">
        Saved searches{#if savedSearches.length > 0}
          <span class="ml-1 text-xs font-normal text-surface-400"
            >({savedSearches.length})</span
          >{/if}
      </summary>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
        {#if showSaveSearch}
          <form
            class="flex w-full gap-2 sm:w-auto"
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
            />
            <button
              type="submit"
              class="btn preset-filled-secondary-500 h-9"
              disabled={!saveSearchName.trim()}>Save</button
            >
          </form>
        {/if}
      </div>
      {#if savedSearches.length > 0}
        <div class="mt-3 flex flex-wrap gap-2">
          {#each savedSearches as savedSearch (savedSearch.id)}
            <button
              type="button"
              class="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-surface-300 transition hover:border-secondary-400/40 hover:text-secondary-200"
              onclick={() => loadSavedSearch(savedSearch)}
              >{savedSearch.name}</button
            >
          {/each}
        </div>
      {/if}
    </details>
  {/if}

  {#if errorMessage}
    <div class="glass-card p-8 text-center">
      <p class="text-lg font-semibold text-error-300">{errorMessage}</p>
      <button
        class="btn preset-tonal mt-4"
        type="button"
        onclick={() => void runSearch()}>Try again</button
      >
    </div>
  {:else if loading}
    <div
      class="glass-card flex min-h-56 items-center justify-center p-8 text-center"
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
