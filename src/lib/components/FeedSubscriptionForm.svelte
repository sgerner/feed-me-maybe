<script lang="ts">
  import { tick } from 'svelte';
  import { fetchWithCsrf } from '#lib/client/csrf.ts';

  export type DiscoveredCandidateOption = {
    url: string;
    title: string;
    type: 'rss' | 'atom' | 'json';
    format?: 'rss' | 'atom' | 'json';
    mimeType?: string;
    siteUrl?: string;
    description?: string;
    alreadySubscribed?: boolean;
  };

  let {
    idPrefix = 'feed',
    categories = [],
    submitLabel = 'Add feed',
    submittingLabel = 'Adding feed...',
    disabled = false,
    onCancel,
    onBusyChange,
    onSuccess,
  }: {
    idPrefix?: string;
    categories?: string[];
    submitLabel?: string;
    submittingLabel?: string;
    disabled?: boolean;
    onCancel?: () => void;
    onBusyChange?: (busy: boolean) => void;
    onSuccess?: (feed: Record<string, unknown>) => void | Promise<void>;
  } = $props();

  let feedUrl = $state('');
  let feedTitle = $state('');
  let feedCategory = $state('');
  let loading = $state(false);
  let feedError = $state('');
  let feedUrlInvalid = $state(false);
  let candidates = $state<DiscoveredCandidateOption[]>([]);
  let selectedCandidateUrl = $state('');
  let submittedSiteUrl = $state('');
  let urlInputEl = $state<HTMLInputElement | null>(null);
  let candidateFieldsetEl = $state<HTMLFieldSetElement | null>(null);

  const isSelectingCandidate = $derived(candidates.length > 1);
  const selectedCandidate = $derived(
    candidates.find((candidate) => candidate.url === selectedCandidateUrl) ??
      candidates[0] ??
      null,
  );
  const formDisabled = $derived(loading || disabled);
  const uniqueCategories = $derived(
    Array.from(
      new Set(
        categories
          .map((category) => category.trim())
          .filter((category) => category.length > 0),
      ),
    ).sort((left, right) => left.localeCompare(right)),
  );

  function setBusy(nextBusy: boolean) {
    loading = nextBusy;
    onBusyChange?.(nextBusy);
  }

  function formatBadgeLabel(format: string | undefined): string {
    if (format === 'atom') return 'Atom';
    if (format === 'json') return 'JSON';
    return 'RSS';
  }

  async function resetCandidateSelection() {
    candidates = [];
    selectedCandidateUrl = '';
    submittedSiteUrl = '';
    feedError = '';
    feedUrlInvalid = false;
    await tick();
    urlInputEl?.focus();
  }

  async function handleSubmit(event: Event) {
    event.preventDefault();
    const targetUrl = isSelectingCandidate
      ? selectedCandidateUrl.trim()
      : feedUrl.trim();
    if (!targetUrl || formDisabled) return;

    const submittingCandidate = isSelectingCandidate;
    setBusy(true);
    feedError = '';
    feedUrlInvalid = false;

    try {
      const response = await fetchWithCsrf('/api/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          title: feedTitle.trim(),
          category: feedCategory.trim(),
        }),
      });

      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        field?: string;
        feed?: Record<string, unknown>;
        candidates?: DiscoveredCandidateOption[];
      } | null;

      if (!response.ok) {
        feedError = payload?.error || 'Failed to add feed';
        feedUrlInvalid = !submittingCandidate && payload?.field === 'url';
        return;
      }

      if (
        !submittingCandidate &&
        Array.isArray(payload?.candidates) &&
        payload.candidates.length > 1
      ) {
        const discoveredCandidates = payload.candidates;
        const firstUnsubscribed = discoveredCandidates.find(
          (candidate) => !candidate.alreadySubscribed,
        );
        candidates = discoveredCandidates;
        submittedSiteUrl = targetUrl;
        selectedCandidateUrl = (firstUnsubscribed ?? discoveredCandidates[0])
          .url;
        setBusy(false);
        await tick();
        const focusTarget =
          candidateFieldsetEl?.querySelector<HTMLInputElement>(
            'input[type="radio"]:checked',
          ) ??
          candidateFieldsetEl?.querySelector<HTMLInputElement>(
            'input[type="radio"]',
          );
        focusTarget?.focus();
        return;
      }

      feedUrl = '';
      feedTitle = '';
      feedCategory = '';
      candidates = [];
      selectedCandidateUrl = '';
      submittedSiteUrl = '';
      setBusy(false);
      await onSuccess?.(payload?.feed ?? {});
    } catch {
      feedError = 'Failed to add feed. Check your connection and try again.';
    } finally {
      if (loading) setBusy(false);
    }
  }
</script>

<form
  class="space-y-4"
  aria-describedby={feedError && !feedUrlInvalid
    ? `${idPrefix}-error`
    : undefined}
  onsubmit={handleSubmit}
>
  {#if isSelectingCandidate}
    <div
      class="flex items-start justify-between gap-3 rounded-sm border border-white/10 bg-white/5 px-3 py-2.5 text-xs text-surface-200"
    >
      <div class="min-w-0">
        <p class="font-semibold text-surface-100">
          Multiple feeds found ({candidates.length})
        </p>
        <p class="mt-0.5 truncate text-surface-300" title={submittedSiteUrl}>
          Choose a stream from {submittedSiteUrl}
        </p>
      </div>
      <button
        type="button"
        class="shrink-0 text-xs font-medium text-primary-300 underline underline-offset-2 hover:text-primary-200"
        onclick={resetCandidateSelection}
        disabled={formDisabled}
      >
        Change URL
      </button>
    </div>

    <fieldset
      bind:this={candidateFieldsetEl}
      class="space-y-2"
      disabled={formDisabled}
    >
      <legend class="mb-1 block text-sm font-medium text-surface-200">
        Select a feed
      </legend>
      {#each candidates as candidate (candidate.url)}
        {@const isSelected = selectedCandidateUrl === candidate.url}
        <label
          class="flex cursor-pointer items-start gap-3 rounded-sm border p-3 transition {isSelected
            ? 'border-primary-400/60 bg-primary-500/12'
            : 'border-white/10 bg-white/5 hover:border-white/25'}"
        >
          <input
            type="radio"
            name="{idPrefix}-candidate"
            value={candidate.url}
            bind:group={selectedCandidateUrl}
            onchange={() => {
              feedError = '';
            }}
            class="mt-1 shrink-0 accent-primary-500"
            disabled={formDisabled}
          />
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap items-center gap-2">
              <span class="font-medium text-sm text-surface-100">
                {candidate.title}
              </span>
              <span
                class="rounded-sm bg-white/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-surface-200"
              >
                {formatBadgeLabel(candidate.format ?? candidate.type)}
              </span>
              {#if candidate.alreadySubscribed}
                <span
                  class="rounded-sm bg-warning-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning-300"
                >
                  Subscribed
                </span>
              {/if}
            </span>
            <span class="mt-1 block break-all text-xs text-surface-300">
              {candidate.url}
            </span>
          </span>
        </label>
      {/each}
    </fieldset>
  {:else}
    <label class="label block">
      <span class="mb-1 block text-sm font-medium text-surface-200"
        >Feed URL</span
      >
      <input
        bind:this={urlInputEl}
        id="{idPrefix}-url"
        name="feedUrl"
        type="url"
        bind:value={feedUrl}
        oninput={() => {
          feedError = '';
          feedUrlInvalid = false;
        }}
        placeholder="https://example.com/feed.xml"
        autocomplete="url"
        class="input glass-input w-full"
        aria-invalid={feedUrlInvalid ? 'true' : undefined}
        aria-describedby={feedUrlInvalid
          ? `${idPrefix}-url-help ${idPrefix}-error`
          : `${idPrefix}-url-help`}
        required
        disabled={formDisabled}
      />
      <span
        id="{idPrefix}-url-help"
        class="mt-1 block text-xs text-surface-300"
      >
        RSS, Atom, JSON Feed, website, or Reddit URLs work too.
      </span>
    </label>
  {/if}

  <label class="label block">
    <span class="mb-1 block text-sm font-medium text-surface-200">
      Feed title <span class="font-normal text-surface-300">(optional)</span>
    </span>
    <input
      id="{idPrefix}-title"
      name="feedTitle"
      type="text"
      bind:value={feedTitle}
      placeholder={isSelectingCandidate && selectedCandidate?.title
        ? selectedCandidate.title
        : "Use the feed's title"}
      autocomplete="off"
      class="input glass-input w-full"
      disabled={formDisabled}
    />
  </label>

  <label class="label block">
    <span class="mb-1 block text-sm font-medium text-surface-200">
      Category <span class="font-normal text-surface-300">(optional)</span>
    </span>
    <input
      id="{idPrefix}-category"
      name="feedCategory"
      type="text"
      bind:value={feedCategory}
      placeholder="e.g. Tech, News, Releases"
      list="{idPrefix}-categories"
      autocomplete="off"
      class="input glass-input w-full"
      disabled={formDisabled}
    />
  </label>

  <datalist id="{idPrefix}-categories">
    {#each uniqueCategories as category (category)}
      <option value={category}></option>
    {/each}
  </datalist>

  {#if feedError}
    <div
      id="{idPrefix}-error"
      class="flex items-center gap-2 px-3 py-2 text-sm"
      role="alert"
      style="background: color-mix(in oklch, var(--color-error-500) 10%, transparent); color: var(--color-error-300); border: 1px solid color-mix(in oklch, var(--color-error-500) 20%, transparent); border-radius: 2px;"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        class="shrink-0"
        aria-hidden="true"
        ><circle cx="12" cy="12" r="10" /><line
          x1="12"
          y1="8"
          x2="12"
          y2="12"
        /><line x1="12" y1="16" x2="12.01" y2="16" /></svg
      >
      <span>{feedError}</span>
    </div>
  {/if}

  {#if onCancel}
    <div class="flex justify-end gap-3 pt-2">
      <button
        type="button"
        class="btn preset-tonal"
        onclick={onCancel}
        disabled={formDisabled}
      >
        Cancel
      </button>
      <button
        type="submit"
        class="btn preset-filled-primary-500 inline-flex min-h-11 items-center justify-center gap-2"
        disabled={formDisabled ||
          (isSelectingCandidate ? !selectedCandidateUrl : !feedUrl.trim())}
      >
        {#if loading}
          <svg
            class="h-4 w-4 animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg
          >
          {submittingLabel}
        {:else}
          {isSelectingCandidate ? 'Subscribe' : submitLabel}
        {/if}
      </button>
    </div>
  {:else}
    <button
      type="submit"
      class="btn preset-filled-primary-500 inline-flex min-h-11 w-full items-center justify-center gap-2"
      disabled={formDisabled ||
        (isSelectingCandidate ? !selectedCandidateUrl : !feedUrl.trim())}
    >
      {#if loading}
        <svg
          class="animate-spin"
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg
        >
        {submittingLabel}
      {:else}
        {isSelectingCandidate ? 'Subscribe' : submitLabel}
      {/if}
    </button>
  {/if}
</form>
