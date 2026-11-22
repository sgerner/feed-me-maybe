<script lang="ts">
  import { tick } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { fetchWithCsrf } from '#lib/client/csrf.ts';

  type PreferenceItem = {
    id: string;
    polarity: 'positive' | 'negative';
    type: string;
    label: string;
    displayLabel?: string;
    displayType?: string;
    strength: number;
    evidence_count: number;
    last_reinforced?: number;
    explanation?: string;
  };

  const SPECIAL_TOKENS: Record<string, string> = {
    c_plus_plus: 'C++',
    c_sharp: 'C#',
    f_sharp: 'F#',
    dotnet: '.NET',
    nodejs: 'Node.js',
    ai: 'AI',
    llm: 'LLM',
    llms: 'LLMs',
    api: 'API',
    apis: 'APIs',
    sql: 'SQL',
    css: 'CSS',
    html: 'HTML',
    rss: 'RSS',
    seo: 'SEO',
    ui: 'UI',
    ux: 'UX',
  };

  function formatWord(word: string): string {
    const lower = word.toLowerCase();
    if (SPECIAL_TOKENS[lower]) return SPECIAL_TOKENS[lower];
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }

  function formatLabel(item: PreferenceItem): string {
    if (item.displayLabel) return item.displayLabel;
    const raw = (item.label || '').trim();
    if (!raw) return 'Unnamed preference';
    const stripped = raw.replace(
      /^(?:phrase|topic|entity|author|signal|content_type|negative_filter|feed):/i,
      '',
    );
    if (!stripped) return raw;
    if (
      (item.type === 'phrase' || /^phrase:/i.test(raw)) &&
      stripped.includes(':')
    ) {
      return stripped
        .split(':')
        .map((part) => part.trim())
        .filter(Boolean)
        .map(formatWord)
        .join(' · ');
    }
    if (SPECIAL_TOKENS[stripped.toLowerCase()]) {
      return SPECIAL_TOKENS[stripped.toLowerCase()];
    }
    return stripped
      .split(/(?<!c_plus|c|f)_(?!plus|sharp)|[:\s-]+/)
      .filter(Boolean)
      .map(formatWord)
      .join(' ');
  }

  function formatType(item: PreferenceItem): string {
    if (item.displayType) return item.displayType;
    const normalized = (item.type || '').trim().toLowerCase();
    switch (normalized) {
      case 'topic':
        return 'Topic';
      case 'entity':
        return 'Entity';
      case 'author':
        return 'Author';
      case 'signal':
        return 'Quality Signal';
      case 'content_type':
        return 'Content Type';
      case 'negative_filter':
        return item.polarity === 'positive'
          ? 'Content Filter (Allowed)'
          : 'Content Filter';
      case 'phrase':
        return 'Title Phrase';
      default:
        return (
          normalized
            .split(/[_\s-]+/)
            .filter(Boolean)
            .map(formatWord)
            .join(' ') || 'Preference'
        );
    }
  }

  function formatReinforcedAgo(timestamp?: number): string {
    if (!timestamp || !Number.isFinite(timestamp)) return '';
    const days = Math.max(
      0,
      Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1000)),
    );
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
  }

  let { data: pageData } = $props();
  let msg = $state('');
  let pending = $state(false);
  let failed = $state(false);
  let preferences = $derived((pageData?.preferences ?? []) as PreferenceItem[]);
  let polarityFilter = $state<'all' | 'positive' | 'negative'>('all');
  let showPhrases = $state(false);
  let phraseLimit = $state(12);
  let confirmingDeleteId = $state<string | null>(null);
  let confirmingReset = $state(false);

  const filteredPreferences = $derived(
    preferences.filter((p) =>
      polarityFilter === 'all' ? true : p.polarity === polarityFilter,
    ),
  );

  const primaryPreferences = $derived(
    filteredPreferences.filter((p) => p.type !== 'phrase'),
  );

  const phrasePreferences = $derived(
    filteredPreferences.filter((p) => p.type === 'phrase'),
  );

  const phrasesExpanded = $derived(
    showPhrases ||
      (primaryPreferences.length === 0 && phrasePreferences.length > 0),
  );

  async function promptDeletePreference(id: string) {
    confirmingReset = false;
    confirmingDeleteId = id;
    await tick();
    document.getElementById(`confirm-delete-pref-${id}`)?.focus();
  }

  async function cancelDeletePreference(id: string) {
    confirmingDeleteId = null;
    await tick();
    document.getElementById(`delete-pref-${id}`)?.focus();
  }

  async function promptResetTraining() {
    confirmingDeleteId = null;
    confirmingReset = true;
    await tick();
    document.getElementById('confirm-reset-training')?.focus();
  }

  async function cancelResetTraining() {
    confirmingReset = false;
    await tick();
    document.getElementById('reset-training-trigger')?.focus();
  }

  async function updateTraining(key: string, id?: string) {
    if (pending) return;
    pending = true;
    msg = '';
    failed = false;
    const oldIndex = id
      ? preferences.findIndex((preference) => preference.id === id)
      : -1;
    try {
      const response = await fetchWithCsrf('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: 'true' }),
      });
      if (!response.ok) throw new Error('Preference update failed');
      preferences = id
        ? preferences.filter((preference) => preference.id !== id)
        : [];
      confirmingDeleteId = null;
      confirmingReset = false;
      msg = id ? 'Preference removed.' : 'Training data reset.';
      await tick();
      if (id) {
        const nextPref =
          preferences[Math.min(oldIndex, preferences.length - 1)];
        const nextTarget = nextPref
          ? document.getElementById(`delete-pref-${nextPref.id}`)
          : document.getElementById('memory-preferences-heading');
        nextTarget?.focus();
      } else {
        document.getElementById('memory-preferences-heading')?.focus();
      }
    } catch {
      failed = true;
      msg = id
        ? 'Could not remove preference.'
        : 'Could not reset training data.';
    } finally {
      pending = false;
    }
  }
</script>

<svelte:head>
  <title>Memory &amp; Preferences · Feed Me Maybe</title>
</svelte:head>

<h2 id="memory-preferences-heading" tabindex="-1" class="section-title text-lg">
  Memory &amp; Preferences
</h2>
<p class="section-subtitle">
  Learned preferences based on your interactions. Signal strength decays
  automatically with a 45-day half-life unless reinforced.
</p>

{#if msg}
  <div
    class="mt-5 flex items-center gap-2 px-3 py-2 text-sm"
    role={failed ? 'alert' : 'status'}
    style="background: color-mix(in oklch, var(--color-success-500) 10%, transparent); color: {failed
      ? 'var(--color-error-300)'
      : 'var(--color-success-300)'}; border: 1px solid color-mix(in oklch, var(--color-success-500) 20%, transparent); border-radius: 2px;"
    in:fly={{ y: 6, duration: 220 }}
  >
    {msg}
  </div>
{/if}

{#if preferences.length === 0}
  <div
    class="glass-card mt-8 p-8 text-center text-sm"
    style="color: var(--color-surface-300);"
    in:fade={{ duration: 300 }}
  >
    <div
      class="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full"
      style="background: color-mix(in oklch, var(--color-tertiary-500) 10%, transparent);"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
        style="color: var(--color-tertiary-400);"
      >
        <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" /><path
          d="M8.5 8.5v.01"
        /><path d="M16 15.5v.01" /><path d="M12 12v.01" /><path
          d="M11 17v.01"
        /><path d="M7 14v.01" /></svg
      >
    </div>
    <p class="font-medium" style="color: var(--color-surface-100);">
      No preferences learned yet
    </p>
    <p class="mt-1">Interact with articles to build your profile.</p>
  </div>
{:else}
  <div
    class="mt-6 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4"
  >
    <div
      class="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Filter preferences by polarity"
    >
      <button
        type="button"
        class="btn px-3 py-1.5 text-xs {polarityFilter === 'all'
          ? 'preset-filled-primary-500'
          : 'preset-tonal'}"
        aria-pressed={polarityFilter === 'all'}
        onclick={() => (polarityFilter = 'all')}
      >
        All ({preferences.length})
      </button>
      <button
        type="button"
        class="btn px-3 py-1.5 text-xs {polarityFilter === 'positive'
          ? 'preset-filled-primary-500'
          : 'preset-tonal'}"
        aria-pressed={polarityFilter === 'positive'}
        onclick={() => (polarityFilter = 'positive')}
      >
        ↑ Preferred ({preferences.filter((p) => p.polarity === 'positive')
          .length})
      </button>
      <button
        type="button"
        class="btn px-3 py-1.5 text-xs {polarityFilter === 'negative'
          ? 'preset-filled-primary-500'
          : 'preset-tonal'}"
        aria-pressed={polarityFilter === 'negative'}
        onclick={() => (polarityFilter = 'negative')}
      >
        ↓ Avoided ({preferences.filter((p) => p.polarity === 'negative')
          .length})
      </button>
    </div>
    <span class="text-xs text-surface-300">
      45-day half-life decay active
    </span>
  </div>

  {#snippet preferenceCard(p: PreferenceItem, i: number)}
    {@const label = formatLabel(p)}
    {@const typeLabel = formatType(p)}
    {@const reinforcedAgo = formatReinforcedAgo(p.last_reinforced)}
    <div
      class="glass-card glass-card-hover p-4"
      in:fly={{ y: 10, duration: 280, delay: Math.min(i * 30, 300) }}
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1 space-y-1.5">
          <div class="flex flex-wrap items-center gap-2">
            {#if p.polarity === 'positive'}
              <span
                class="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-success-300"
                style="background: color-mix(in oklch, var(--color-success-500) 15%, transparent);"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg
                >
                Preferred · Boosts score
              </span>
            {:else}
              <span
                class="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-warning-300"
                style="background: color-mix(in oklch, var(--color-warning-500) 15%, transparent);"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg
                >
                Avoided · Lowers score
              </span>
            {/if}
            <span
              class="inline-flex items-center rounded bg-surface-200/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-surface-300"
            >
              {typeLabel}
            </span>
          </div>
          <div
            class="text-sm font-semibold"
            style="color: var(--color-surface-50);"
          >
            {label}
          </div>
          {#if p.explanation && p.explanation.trim()}
            <p class="text-xs leading-relaxed text-surface-300">
              {p.explanation}
            </p>
          {/if}
        </div>

        <div class="flex flex-none items-center gap-2">
          {#if confirmingDeleteId === p.id}
            <div
              class="flex flex-wrap items-center gap-2 rounded border border-error-500/30 bg-error-500/10 px-2.5 py-1"
              role="group"
              aria-label={`Confirm deleting preference "${label}"`}
            >
              <span class="text-xs text-error-300">Remove?</span>
              <button
                type="button"
                id="confirm-delete-pref-{p.id}"
                class="btn preset-tonal-error px-2.5 py-1 text-xs font-semibold"
                aria-label={`Confirm delete preference "${label}"`}
                onclick={() => updateTraining(`delete_pref_${p.id}`, p.id)}
                disabled={pending}
              >
                Confirm
              </button>
              <button
                type="button"
                class="btn preset-tonal px-2.5 py-1 text-xs"
                aria-label={`Cancel delete preference "${label}"`}
                onclick={() => cancelDeletePreference(p.id)}
                disabled={pending}
              >
                Cancel
              </button>
            </div>
          {:else}
            <button
              type="button"
              id="delete-pref-{p.id}"
              class="flex h-8 w-8 items-center justify-center text-xs transition-colors hover:bg-surface-100/10"
              style="color: var(--color-surface-300); border-radius: 2px;"
              aria-label={`Delete preference "${label}"`}
              onclick={() => promptDeletePreference(p.id)}
              disabled={pending}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                aria-hidden="true"
                ><line x1="18" y1="6" x2="6" y2="18" /><line
                  x1="6"
                  y1="6"
                  x2="18"
                  y2="18"
                /></svg
              >
            </button>
          {/if}
        </div>
      </div>

      <div
        class="mt-3 flex flex-wrap items-center gap-3 text-xs"
        style="color: var(--color-surface-300);"
      >
        <div
          class="h-2 w-28 overflow-hidden"
          style="background: color-mix(in oklch, var(--color-surface-100) 8%, transparent); border-radius: 2px;"
        >
          <div
            class="h-2 transition-all duration-500"
            style="width: {Math.min(
              100,
              Math.max(0, p.strength * 100),
            )}%; background: {p.polarity === 'positive'
              ? 'linear-gradient(90deg, var(--color-success-500), var(--color-primary-500))'
              : 'linear-gradient(90deg, var(--color-warning-500), var(--color-error-500))'}; border-radius: 2px;"
          ></div>
        </div>
        <span>
          {(p.strength * 100).toFixed(0)}% decayed strength · {p.evidence_count}
          {p.evidence_count === 1
            ? 'interaction'
            : 'interactions'}{reinforcedAgo
            ? ` · reinforced ${reinforcedAgo}`
            : ''}
        </span>
      </div>
    </div>
  {/snippet}

  {#if primaryPreferences.length > 0}
    <div
      class="mt-6 space-y-3"
      aria-label="Learned topics, authors, and signals"
    >
      {#each primaryPreferences as p, i (p.id)}
        {@render preferenceCard(p, i)}
      {/each}
    </div>
  {/if}

  {#if phrasePreferences.length > 0}
    <section
      class="mt-6 rounded-2xl border border-surface-200/10 bg-surface-900/20 p-4"
      aria-labelledby="phrase-preferences-heading"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3
            id="phrase-preferences-heading"
            class="text-sm font-semibold text-surface-100"
          >
            Learned Title Phrases ({phrasePreferences.length})
          </h3>
          <p class="mt-0.5 text-xs text-surface-300">
            Keyword combinations extracted from explicitly liked, saved, or
            disliked article titles.
          </p>
        </div>
        <button
          type="button"
          class="btn preset-tonal px-3 py-1.5 text-xs"
          aria-expanded={phrasesExpanded}
          onclick={() => (showPhrases = !phrasesExpanded)}
        >
          {phrasesExpanded
            ? 'Hide title phrases'
            : `Show ${phrasePreferences.length} title phrases`}
        </button>
      </div>

      {#if phrasesExpanded}
        <div class="mt-4 space-y-3">
          {#each phrasePreferences.slice(0, phraseLimit) as p, i (p.id)}
            {@render preferenceCard(p, i)}
          {/each}
          {#if phrasePreferences.length > phraseLimit}
            <button
              type="button"
              class="btn preset-tonal mt-2 w-full py-2 text-xs"
              onclick={() => (phraseLimit += 24)}
            >
              Show more title phrases ({phrasePreferences.length - phraseLimit}
              remaining)
            </button>
          {/if}
        </div>
      {/if}
    </section>
  {/if}
{/if}

<div class="mt-6">
  {#if confirmingReset}
    <div
      class="glass-card space-y-3 border border-error-500/30 p-4"
      role="group"
      aria-labelledby="confirm-reset-heading"
    >
      <h3
        id="confirm-reset-heading"
        class="text-sm font-semibold text-error-300"
      >
        Reset learned preferences and ranking feedback?
      </h3>
      <p class="text-xs leading-relaxed text-surface-300">
        This clears interaction history used for learning, while reading status,
        saved articles, and article reactions stay intact.
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          id="confirm-reset-training"
          class="btn preset-tonal-error px-3 py-1.5 text-xs font-semibold"
          onclick={() => updateTraining('reset_training')}
          disabled={pending}
        >
          Confirm reset all training
        </button>
        <button
          type="button"
          class="btn preset-tonal px-3 py-1.5 text-xs"
          onclick={cancelResetTraining}
          disabled={pending}
        >
          Cancel
        </button>
      </div>
    </div>
  {:else}
    <button
      type="button"
      id="reset-training-trigger"
      class="action-btn px-4 py-2 text-error-300"
      style="border-color: color-mix(in oklch, var(--color-error-500) 15%, transparent);"
      onclick={promptResetTraining}
      disabled={pending}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
        ><path d="M3 6h18" /><path
          d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"
        /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg
      >
      Reset All Training
    </button>
  {/if}
</div>
