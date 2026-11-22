<script lang="ts">
  import { onMount } from 'svelte';
  import { syncFeeds } from '#lib/feeds.ts';
  import { cacheDigest, getCachedDigests } from '#lib/offline/index.ts';
  import type { OfflineJsonValue } from '#lib/offline/index.ts';
  import { formatContent } from '#lib/utils/format.ts';
  import { addToast } from '#lib/stores/toast.svelte.ts';
  import {
    EMPTY_DIGEST,
    type DigestArticle,
    type WeeklyDigestResult as WeeklyDigest,
    type WeeklyDigestStory as DigestStory,
  } from '#lib/digest-types.ts';

  type RankedStory = DigestStory & {
    section: string;
    accent: string;
  };

  let digest = $state<WeeklyDigest>(EMPTY_DIGEST);
  let loading = $state(true);
  let hasLoaded = $state(false);
  let refreshing = $state(false);
  let errorMessage = $state('');
  let statusAnnouncement = $state('');
  let selectedDays = $state(7);
  let showAll = $state(false);
  let allQuery = $state('');
  let activeClusterFilter = $state<{
    title: string;
    articleIds: string[];
  } | null>(null);
  let requestId = 0;
  let abortController: AbortController | null = null;

  function renderDigestMarkdown(text: string | null | undefined): string {
    if (!text) return '';
    const html = formatContent(text).trim();
    const singleParagraph = html.match(/^<p>([\s\S]*?)<\/p>$/i);
    if (
      singleParagraph &&
      !/<\/?(?:p|ul|ol|li|blockquote|pre|table|div)\b/i.test(singleParagraph[1])
    ) {
      return singleParagraph[1];
    }
    return html;
  }

  const rankedStories = $derived.by<RankedStory[]>(() => {
    const groups = [
      {
        section: 'Top signal',
        accent: 'var(--color-primary-300)',
        stories: digest.briefing?.topSignal || digest.topStories || [],
      },
      {
        section: 'Worth your time',
        accent: 'var(--color-secondary-300)',
        stories: digest.briefing?.worthYourTime || digest.missedStories || [],
      },
      {
        section: 'What changed',
        accent: 'var(--color-warning-300)',
        stories: digest.briefing?.whatChanged || [],
      },
    ];
    const seen = new Set<string>();
    const result: RankedStory[] = [];
    for (const group of groups) {
      for (const story of group.stories) {
        if (seen.has(story.article.id)) continue;
        seen.add(story.article.id);
        result.push({ ...story, section: group.section, accent: group.accent });
      }
    }
    return result;
  });

  const isAllListVisible = $derived(
    showAll || allQuery.trim().length > 0 || activeClusterFilter !== null,
  );

  const filteredAllArticles = $derived.by(() => {
    const query = allQuery.trim().toLowerCase();
    const clusterIds = activeClusterFilter
      ? new Set(activeClusterFilter.articleIds)
      : null;

    return digest.allArticles.filter((article) => {
      if (clusterIds && !clusterIds.has(article.id)) return false;
      if (!query) return true;
      return `${article.title} ${article.feed_title || ''}`
        .toLowerCase()
        .includes(query);
    });
  });

  function isTrue(value: boolean | number | undefined): boolean {
    return value === true || value === 1;
  }
  function articleDate(article: DigestArticle): number {
    return article.published_at || article.fetched_at || Date.now();
  }
  function timeAgo(date: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - date) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(date).toLocaleDateString();
  }
  function windowLabel(value: number): string {
    return new Date(value).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  }
  function formatError(value: unknown): string {
    return value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : 'Unable to load the calm daily briefing.';
  }

  function briefingFromLegacy(data: WeeklyDigest): WeeklyDigest {
    if (data.briefing) {
      return {
        ...data,
        aiEnabled: Boolean(data.aiEnabled),
        aiGenerated: Boolean(data.aiGenerated),
      };
    }
    return {
      ...data,
      aiEnabled: Boolean(data.aiEnabled),
      aiGenerated: Boolean(data.aiGenerated),
      briefing: {
        headline: data.headline,
        summary: data.summary,
        topSignal: data.topStories || [],
        worthYourTime: data.missedStories || [],
        whatChanged: [],
        uncertainty: [],
      },
      inclusionCounts: data.inclusionCounts || EMPTY_DIGEST.inclusionCounts,
      allArticles: data.allArticles || [],
      history: data.history || [],
      clusters: data.clusters || [],
      deduplicatedArticles: data.deduplicatedArticles || data.totalArticles,
    };
  }

  function filterByCluster(story: DigestStory) {
    activeClusterFilter = {
      title: story.article.title,
      articleIds:
        story.relatedArticleIds.length > 0
          ? story.relatedArticleIds
          : [story.article.id],
    };
    showAll = true;
    document
      .getElementById('all-included')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function filterBySource(feedTitle: string) {
    activeClusterFilter = null;
    allQuery = feedTitle;
    showAll = true;
    document
      .getElementById('all-included')
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function clearIncludedFilters() {
    activeClusterFilter = null;
    allQuery = '';
  }

  async function loadDigest(options: { sync?: boolean; force?: boolean } = {}) {
    const currentRequest = ++requestId;
    abortController?.abort();
    abortController = new AbortController();
    if (!hasLoaded) loading = true;
    else refreshing = true;
    statusAnnouncement = hasLoaded
      ? 'Refreshing briefing.'
      : 'Loading briefing.';
    errorMessage = '';
    try {
      if (options.sync) await syncFeeds({ silent: true });
      const params = new URLSearchParams({ days: String(selectedDays) });
      if (options.force) params.set('refresh', '1');
      const res = await fetch(`/api/digest?${params.toString()}`, {
        headers: { Accept: 'application/json' },
        signal: abortController.signal,
      });
      if (!res.ok)
        throw new Error(
          res.status === 401 ? 'Unauthorized' : 'Failed to load the briefing.',
        );
      const data = briefingFromLegacy((await res.json()) as WeeklyDigest);
      if (currentRequest !== requestId) return;
      digest = data;
      selectedDays = data.windowDays || selectedDays;
      hasLoaded = true;
      if (data.aiEnabled && !data.aiGenerated) {
        statusAnnouncement = `AI synthesis unavailable; showing heuristic fallback briefing for ${data.totalArticles} eligible stories from ${data.totalFeeds} feeds.`;
        if (options.force) {
          addToast(
            'AI synthesis unavailable — showing heuristic fallback briefing.',
            'warning',
          );
        }
      } else if (!data.aiEnabled) {
        statusAnnouncement = `Heuristic briefing ready (AI disabled). ${data.totalArticles} eligible stories from ${data.totalFeeds} feeds.`;
      } else {
        statusAnnouncement = `AI briefing ready. ${data.totalArticles} eligible stories from ${data.totalFeeds} feeds.`;
      }
      void cacheDigest('admin', {
        id: `briefing-${data.windowDays || selectedDays}-${data.generatedAt}`,
        generatedAt: data.generatedAt,
        payload: JSON.parse(JSON.stringify(data)) as OfflineJsonValue,
      }).catch(() => undefined);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (currentRequest !== requestId) return;
      if (navigator.onLine === false) {
        const cached = await getCachedDigests('admin', 8);
        const cachedBriefing = cached.find((item) => {
          const payload = item.payload as Partial<WeeklyDigest>;
          return payload.windowDays === selectedDays;
        });
        if (cachedBriefing) {
          digest = briefingFromLegacy(
            cachedBriefing.payload as unknown as WeeklyDigest,
          );
          selectedDays = digest.windowDays || selectedDays;
          hasLoaded = true;
          errorMessage = '';
          statusAnnouncement = `Loaded cached briefing. ${digest.totalArticles} eligible stories.`;
          return;
        }
      }
      errorMessage = formatError(err);
      statusAnnouncement = '';
    } finally {
      if (currentRequest === requestId) {
        loading = false;
        refreshing = false;
        hasLoaded = true;
      }
    }
  }

  onMount(() => {
    void loadDigest();
    return () => abortController?.abort();
  });
  function handleRefresh() {
    void loadDigest({ force: true });
  }
  function handleWindowChange(event: Event) {
    selectedDays =
      Number((event.currentTarget as HTMLSelectElement).value) || 7;
    void loadDigest();
  }
</script>

<svelte:head>
  <title>Calm Daily Briefing · Feed Me Maybe</title>
  <meta
    name="description"
    content="A calm, source-grounded briefing from your complete eligible reading set."
  />
</svelte:head>

<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
  {statusAnnouncement}
</p>

<div class="mx-auto max-w-6xl pb-12" aria-busy={refreshing || loading}>
  {#if loading && !hasLoaded}
    <div class="space-y-6" aria-busy="true" aria-label="Loading briefing">
      <div class="animate-pulse space-y-3 pt-2">
        <div class="h-3 w-32 rounded-full bg-surface-200/15"></div>
        <div class="h-10 w-3/4 rounded-sm bg-surface-200/15"></div>
        <div class="h-5 w-full max-w-2xl rounded-sm bg-surface-200/10"></div>
      </div>
      <div class="grid gap-4 lg:grid-cols-3">
        {#each [1, 2, 3] as item (item)}<div
            class="animate-pulse rounded-2xl border border-surface-200/10 bg-surface-900/25 p-5"
          >
            <div class="h-3 w-24 rounded bg-surface-200/10"></div>
            <div class="mt-5 h-6 w-full rounded bg-surface-200/10"></div>
            <div class="mt-3 h-4 w-5/6 rounded bg-surface-200/10"></div>
            <div class="mt-2 h-4 w-2/3 rounded bg-surface-200/10"></div>
          </div>{/each}
      </div>
    </div>
  {:else if errorMessage}
    <div class="glass-card mt-12 p-8 text-center">
      <p class="mb-2 text-lg font-medium text-surface-100">
        Briefing unavailable
      </p>
      <p class="section-subtitle" role="alert">{errorMessage}</p>
      <button
        type="button"
        class="btn preset-filled-surface-200-800 mt-6"
        onclick={handleRefresh}>Retry</button
      >
    </div>
  {:else}
    <header
      class="mb-8 flex flex-col gap-6 border-b border-surface-200/10 pb-7 md:flex-row md:items-end md:justify-between"
    >
      <div class="min-w-0">
        <div
          class="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-primary-300"
        >
          <span
            class="inline-block h-2 w-2 rounded-full bg-primary-300 shadow-[0_0_18px_var(--color-primary-300)]"
          ></span>Calm Daily Briefing
        </div>
        <h1
          class="max-w-3xl text-3xl font-semibold tracking-tight text-surface-50 md:text-5xl"
        >
          {digest.briefing?.headline || digest.headline}
        </h1>
        <p
          class="mt-3 max-w-2xl text-sm leading-relaxed text-surface-300 md:text-base"
        >
          {windowLabel(digest.windowStart)} – {windowLabel(digest.windowEnd)} · {digest.totalFeeds}
          feeds · {digest.totalArticles} eligible stories
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <label class="sr-only" for="briefing-window">Briefing window</label
        ><select
          id="briefing-window"
          class="input min-w-32"
          value={selectedDays}
          onchange={handleWindowChange}
          ><option value="1">Past day</option><option value="3"
            >Past 3 days</option
          ><option value="7">Past 7 days</option><option value="14"
            >Past 14 days</option
          ><option value="30">Past 30 days</option></select
        ><button
          type="button"
          class="btn preset-filled-surface-200-800"
          onclick={handleRefresh}
          disabled={refreshing}
          aria-busy={refreshing}
          aria-label="Refresh briefing"
          >{#if refreshing}<span
              class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            ></span>{:else}Refresh{/if}</button
        >
      </div>
    </header>

    {#if !digest.aiGenerated}
      <div
        class="mb-6 flex flex-col gap-2 rounded-2xl border border-warning-400/25 bg-warning-500/10 p-4 text-sm text-surface-100 sm:flex-row sm:items-center sm:justify-between"
        role="status"
      >
        <div class="flex items-start gap-3">
          <span
            class="mt-0.5 inline-flex flex-none items-center rounded-full bg-warning-500/20 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider text-warning-300"
          >
            {digest.aiEnabled ? 'Heuristic fallback' : 'Heuristic mode'}
          </span>
          <p class="leading-relaxed text-surface-200">
            {#if digest.aiEnabled}
              AI synthesis was unavailable or rate-limited for this window.
              Showing a deterministic briefing grouped by ranking score and
              topic overlap.
            {:else}
              AI synthesis is turned off. Showing a deterministic briefing
              grouped by ranking score and topic overlap.
            {/if}
          </p>
        </div>
        {#if !digest.aiEnabled}
          <a
            href="/settings/ai"
            class="inline-flex min-h-7 flex-none items-center text-xs font-semibold text-primary-300 underline underline-offset-4 hover:text-primary-200"
          >
            Configure AI →
          </a>
        {/if}
      </div>
    {/if}

    <section
      class="mb-8 overflow-hidden rounded-3xl border border-primary-400/20 p-6 shadow-[0_20px_80px_color-mix(in_oklch,var(--color-primary-500)_8%,transparent)] md:p-8"
      style="background: radial-gradient(circle at 0% 0%, color-mix(in oklch, var(--color-primary-500) 16%, transparent), transparent 52%), color-mix(in oklch, var(--color-surface-900) 65%, transparent);"
    >
      <div
        class="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between"
      >
        <div class="max-w-3xl">
          <div
            class="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-primary-300"
          >
            The short version
          </div>
          <div
            class="text-lg leading-relaxed text-surface-50 md:text-2xl md:leading-snug [&_a]:text-primary-300 [&_a]:underline [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5"
          >
            {@html renderDigestMarkdown(
              digest.briefing?.summary ||
                digest.summary ||
                'A quiet readout of what mattered across your feeds.',
            )}
          </div>
        </div>
        <div
          class="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:min-w-[24rem]"
        >
          <div
            class="rounded-2xl border border-surface-200/10 bg-surface-950/20 p-3"
          >
            <div class="text-surface-300">Eligible</div>
            <div class="mt-1 text-xl font-semibold text-surface-50">
              {digest.inclusionCounts.eligibleArticles}
            </div>
          </div>
          <div
            class="rounded-2xl border border-surface-200/10 bg-surface-950/20 p-3"
          >
            <div class="text-surface-300">Read</div>
            <div class="mt-1 text-xl font-semibold text-surface-50">
              {digest.inclusionCounts.read}
            </div>
          </div>
          <div
            class="rounded-2xl border border-surface-200/10 bg-surface-950/20 p-3"
          >
            <div class="text-surface-300">Unread</div>
            <div class="mt-1 text-xl font-semibold text-secondary-300">
              {digest.inclusionCounts.unread}
            </div>
          </div>
          <div
            class="rounded-2xl border border-surface-200/10 bg-surface-950/20 p-3"
          >
            <div class="text-surface-300">Grouped</div>
            <div class="mt-1 text-xl font-semibold text-warning-300">
              {digest.inclusionCounts.deduplicatedArticles}
            </div>
          </div>
        </div>
      </div>
      <div
        class="mt-6 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-wider text-surface-300"
      >
        <span
          class="rounded-full px-3 py-1.5 {digest.aiGenerated
            ? 'bg-primary-500/15 text-primary-300'
            : 'bg-warning-500/15 text-warning-300'}"
        >
          {digest.aiGenerated
            ? 'AI synthesized'
            : digest.aiEnabled
              ? 'Heuristic fallback'
              : 'Heuristic briefing'}
        </span><span
          class="rounded-full bg-success-500/10 px-3 py-1.5 text-success-300"
          >Read + unread processed</span
        ><span
          class="rounded-full bg-primary-500/10 px-3 py-1.5 text-primary-300"
          >{digest.inclusionCounts.hiddenRead} hidden read included</span
        >{#if digest.inclusionCounts.duplicateArticles > 0}<span
            class="rounded-full bg-warning-500/10 px-3 py-1.5 text-warning-300"
            >{digest.inclusionCounts.duplicateArticles} related duplicates grouped</span
          >{/if}{#if digest.cacheHit}<span
            class="rounded-full bg-surface-200/10 px-3 py-1.5"
            >Cached · {timeAgo(digest.generatedAt)}</span
          >{:else}<span class="rounded-full bg-surface-200/10 px-3 py-1.5"
            >Updated {timeAgo(digest.generatedAt)}</span
          >{/if}
      </div>
      {#if digest.takeaways.length > 0}<div
          class="mt-6 grid gap-3 border-t border-surface-200/10 pt-5 md:grid-cols-3"
        >
          {#each digest.takeaways.slice(0, 3) as item}<div
              class="flex gap-2 text-sm leading-relaxed text-surface-200"
            >
              <span
                class="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-primary-300"
              ></span>
              <div
                class="[&_a]:text-primary-300 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-4"
              >
                {@html renderDigestMarkdown(item)}
              </div>
            </div>{/each}
        </div>{/if}
    </section>

    {#if digest.briefing?.uncertainty?.length > 0}<details
        class="mb-8 rounded-2xl border border-warning-400/20 bg-warning-500/5 p-4"
      >
        <summary
          class="flex min-h-7 cursor-pointer items-center text-sm font-semibold text-warning-300"
        >
          Notes about uncertainty ({digest.briefing.uncertainty.length})
        </summary>
        <div class="mt-3 space-y-1.5 text-sm leading-relaxed text-surface-200">
          {#each digest.briefing.uncertainty as note}
            <div class="[&_a]:text-primary-300 [&_a]:underline">
              {@html renderDigestMarkdown(note)}
            </div>
          {/each}
        </div>
      </details>{/if}

    {#if digest.totalArticles === 0}
      <div class="glass-card p-10 text-center">
        <p class="mb-2 text-lg font-medium text-surface-100">
          Nothing needs your attention yet
        </p>
        <p class="section-subtitle">
          No eligible articles arrived in the selected window. Rejected,
          thumbs-down, and hidden-unread items stay out of the briefing.
        </p>
      </div>
    {:else}
      <div
        class="grid gap-8 lg:grid-cols-[minmax(0,1.55fr)_minmax(18rem,0.75fr)]"
      >
        <section aria-labelledby="start-here">
          <div class="mb-4 flex items-end justify-between gap-4">
            <div>
              <div
                class="mb-1 text-[11px] font-bold uppercase tracking-[0.18em] text-primary-300"
              >
                Start here
              </div>
              <h2
                id="start-here"
                class="text-2xl font-semibold tracking-tight text-surface-50"
              >
                Recommended reading
              </h2>
            </div>
            <span class="text-xs text-surface-300"
              >{rankedStories.length} stories</span
            >
          </div>
          {#if rankedStories.length > 0}<div class="space-y-3">
              {#each rankedStories as story, index (story.article.id)}<article
                  class="group rounded-2xl border border-surface-200/10 bg-surface-900/25 p-4 transition duration-300 hover:-translate-y-0.5 hover:border-primary-300/35 hover:bg-surface-900/45 md:p-5"
                >
                  <div class="flex gap-4">
                    <div
                      class="flex h-8 w-8 flex-none items-center justify-center rounded-xl bg-surface-200/10 text-xs font-bold"
                      style="color: {story.accent};"
                    >
                      {String(index + 1).padStart(2, '0')}
                    </div>
                    <div class="min-w-0 flex-1">
                      <div
                        class="mb-1 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-surface-300"
                      >
                        <span style="color: {story.accent};"
                          >{story.section}</span
                        ><span>·</span><button
                          type="button"
                          class="inline-flex min-h-6 items-center rounded px-1.5 py-0.5 text-left transition hover:bg-surface-200/10 hover:text-primary-200"
                          aria-label="Filter included stories by source {story
                            .article.feed_title || 'Unknown feed'}"
                          onclick={() =>
                            filterBySource(
                              story.article.feed_title || 'Unknown feed',
                            )}
                          >{story.article.feed_title || 'Unknown feed'}</button
                        ><span>·</span><span
                          >{timeAgo(articleDate(story.article))}</span
                        ><span
                          class="rounded-full bg-surface-200/10 px-2 py-0.5"
                          >{story.status}</span
                        >{#if story.sourceCount > 1}<button
                            type="button"
                            class="inline-flex min-h-6 items-center rounded-full bg-primary-500/10 px-2.5 py-0.5 text-primary-300 transition hover:bg-primary-500/20"
                            aria-label="Show {story.sourceCount} clustered sources for {story
                              .article.title}"
                            onclick={() => filterByCluster(story)}
                            >{story.sourceCount} sources</button
                          >{/if}
                      </div>
                      <a
                        href="/articles/{story.article.id}?mode=app"
                        class="block min-h-7 py-0.5 text-base font-semibold leading-snug text-surface-50 underline decoration-transparent underline-offset-4 transition group-hover:decoration-primary-300/50 md:text-lg"
                        >{story.article.title}</a
                      >{#if story.reason}<div
                          class="mt-2 text-sm leading-relaxed text-surface-300 [&_a]:text-primary-300 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-4"
                        >
                          {@html renderDigestMarkdown(story.reason)}
                        </div>{/if}{#if story.uncertainty}<div
                          class="mt-2 text-xs leading-relaxed text-warning-300 [&_a]:text-primary-300 [&_a]:underline"
                        >
                          Uncertainty: {@html renderDigestMarkdown(
                            story.uncertainty,
                          )}
                        </div>{/if}
                      <div
                        class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs"
                      >
                        <a
                          href={story.article.url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label="Open source for {story.article.title}"
                          class="inline-flex min-h-6 items-center py-1 text-primary-300 underline decoration-primary-400/30 underline-offset-2 hover:text-primary-200"
                          >Open source ↗</a
                        >{#if isTrue(story.article.saved)}<span
                            class="text-success-300">Saved</span
                          >{/if}{#if isTrue(story.article.read)}<span
                            class="text-surface-300">Read</span
                          >{:else}<span class="text-secondary-300">Unread</span
                          >{/if}{#if story.relatedArticleIds.length > 1}<button
                            type="button"
                            class="inline-flex min-h-6 items-center rounded px-1.5 py-0.5 text-surface-300 underline decoration-surface-400/40 underline-offset-2 transition hover:text-primary-300"
                            aria-label="Show {story.relatedArticleIds
                              .length} related stories for {story.article
                              .title}"
                            onclick={() => filterByCluster(story)}
                            >+{story.relatedArticleIds.length - 1} related</button
                          >{/if}
                      </div>
                    </div>
                  </div>
                </article>{/each}
            </div>{:else}<div
              class="rounded-2xl border border-dashed border-surface-200/15 p-5 text-sm text-surface-300"
            >
              No recommended stories for the selected window.
            </div>{/if}
        </section>

        <aside class="space-y-8" aria-label="Themes and source coverage">
          <details
            class="rounded-2xl border border-surface-200/10 bg-surface-900/20 p-5"
          >
            <summary
              class="flex min-h-7 cursor-pointer items-center text-lg font-semibold text-surface-50"
            >
              Related themes <span
                class="ml-1 text-xs font-normal text-surface-300"
                >({digest.themes.length})</span
              >
            </summary>
            <div class="mt-4 space-y-4">
              {#each digest.themes as theme (theme.name)}<div>
                  <div class="text-sm font-semibold text-surface-100">
                    {theme.name}
                  </div>
                  <div
                    class="mt-1 text-xs leading-relaxed text-surface-300 [&_a]:text-primary-300 [&_a]:underline"
                  >
                    {@html renderDigestMarkdown(theme.summary)}
                  </div>
                  <div class="mt-2 space-y-1.5">
                    {#each theme.articles.slice(0, 3) as article (article.id)}<a
                        href="/articles/{article.id}?mode=app"
                        class="flex min-h-7 items-center truncate py-1.5 text-xs text-primary-300 hover:text-primary-200"
                        >{article.title}</a
                      >{/each}
                  </div>
                </div>{/each}{#if digest.themes.length === 0}<p
                  class="text-sm text-surface-300"
                >
                  Themes will appear as coverage accumulates.
                </p>{/if}
            </div>
          </details>
          <details
            class="rounded-2xl border border-surface-200/10 bg-surface-900/20 p-5"
          >
            <summary
              class="flex min-h-7 cursor-pointer items-center text-lg font-semibold text-surface-50"
            >
              Sources <span class="ml-1 text-xs font-normal text-surface-300"
                >({digest.activeFeeds.length})</span
              >
            </summary>
            <div class="mt-4 max-h-72 space-y-1.5 overflow-y-auto pr-1">
              {#each digest.activeFeeds as feed (feed.title)}
                <button
                  type="button"
                  class="flex min-h-7 w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-surface-200/10"
                  aria-label="Filter included stories by source {feed.title} ({feed.count} stories)"
                  onclick={() => filterBySource(feed.title)}
                >
                  <span class="truncate text-surface-200">{feed.title}</span
                  ><span
                    class="flex-none rounded-full bg-surface-200/10 px-2 py-0.5 text-xs text-surface-300"
                    >{feed.count}</span
                  >
                </button>
              {/each}
            </div>
          </details>
          {#if digest.history.length > 1}<details
              class="rounded-2xl border border-surface-200/10 bg-surface-900/20 p-5"
            >
              <summary
                class="flex min-h-7 cursor-pointer items-center text-lg font-semibold text-surface-50"
              >
                Briefing history <span
                  class="ml-1 text-xs font-normal text-surface-300"
                  >({digest.history.length})</span
                >
              </summary>
              <div class="mt-4 space-y-3">
                {#each digest.history.slice(0, 5) as item (item.signature)}<div
                    class="flex items-start justify-between gap-3 text-xs"
                  >
                    <div>
                      <div class="text-surface-200">{item.headline}</div>
                      <div class="mt-1 text-surface-500">
                        {item.windowDays}d · {item.totalArticles} stories
                      </div>
                    </div>
                    <time class="flex-none text-surface-500"
                      >{new Date(item.generatedAt).toLocaleDateString(
                        undefined,
                        { month: 'short', day: 'numeric' },
                      )}</time
                    >
                  </div>{/each}
              </div>
            </details>{/if}
        </aside>
      </div>

      <section
        class="mt-12 border-t border-surface-200/10 pt-8"
        aria-labelledby="all-included"
      >
        <div
          class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"
        >
          <div>
            <div
              class="mb-1 text-[11px] font-bold uppercase tracking-[0.18em] text-primary-300"
            >
              Full included list
            </div>
            <h2
              id="all-included"
              class="text-2xl font-semibold tracking-tight text-surface-50"
            >
              All included
            </h2>
            <p class="mt-1 text-sm text-surface-300">
              Browse every eligible article used to build this briefing,
              including read items and grouped coverage.
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <label class="sr-only" for="all-included-search"
              >Filter included articles</label
            ><input
              id="all-included-search"
              class="input w-48"
              type="search"
              placeholder="Filter stories"
              bind:value={allQuery}
              oninput={() => {
                if (allQuery.trim().length > 0) showAll = true;
              }}
            /><button
              type="button"
              class="btn preset-outlined-surface-300-700"
              onclick={() => {
                if (isAllListVisible) {
                  showAll = false;
                  clearIncludedFilters();
                } else {
                  showAll = true;
                }
              }}
              >{isAllListVisible
                ? 'Hide list'
                : `Browse ${digest.totalArticles}`}</button
            >
          </div>
        </div>
        {#if activeClusterFilter || allQuery.trim()}
          <div
            class="mt-4 flex flex-wrap items-center gap-2 text-xs text-surface-300"
          >
            {#if activeClusterFilter}
              <span
                class="rounded-full bg-primary-500/15 px-3 py-1 text-primary-300"
              >
                Cluster: {activeClusterFilter.title} ({activeClusterFilter
                  .articleIds.length})
              </span>
            {/if}
            {#if allQuery.trim()}
              <span
                class="rounded-full bg-surface-200/10 px-3 py-1 text-surface-200"
              >
                Filter: “{allQuery.trim()}”
              </span>
            {/if}
            <button
              type="button"
              class="inline-flex min-h-6 items-center rounded px-2 py-0.5 text-primary-300 underline hover:text-primary-200"
              onclick={clearIncludedFilters}
            >
              Clear filter
            </button>
          </div>
        {/if}
        {#if isAllListVisible}<div class="mt-5 grid gap-2 md:grid-cols-2">
            {#each filteredAllArticles as article (article.id)}<article
                class="flex items-start gap-3 rounded-xl border border-surface-200/10 bg-surface-900/20 p-3"
              >
                <div class="min-w-0 flex-1">
                  <a
                    href="/articles/{article.id}?mode=app"
                    class="line-clamp-2 min-h-6 py-0.5 text-sm font-medium text-surface-100 hover:text-primary-200"
                    >{article.title}</a
                  >
                  <div
                    class="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-surface-500"
                  >
                    <span>{article.feed_title || 'Unknown feed'}</span><span
                      >·</span
                    ><span>{timeAgo(articleDate(article))}</span
                    >{#if isTrue(article.read)}<span class="text-surface-300"
                        >read</span
                      >{:else}<span class="text-secondary-300">unread</span
                      >{/if}{#if isTrue(article.hidden)}<span
                        class="text-warning-300">hidden read</span
                      >{/if}
                  </div>
                </div>
                <a
                  href={article.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open source for {article.title}"
                  class="inline-flex min-h-6 min-w-6 flex-none items-center justify-center text-xs text-primary-300"
                  >↗</a
                >
              </article>{/each}
          </div>
          {#if filteredAllArticles.length === 0}<p
              class="mt-5 rounded-xl border border-dashed border-surface-200/15 p-5 text-sm text-surface-300"
            >
              No included stories match that filter.
            </p>{/if}{/if}
      </section>
    {/if}
  {/if}
</div>
