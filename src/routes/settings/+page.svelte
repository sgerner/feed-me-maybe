<script lang="ts">
  import { refreshAll } from '$app/navigation';
  import { tick } from 'svelte';
  import { addToast } from '#lib/stores/toast.svelte.ts';
  import { enhance } from '$app/forms';
  import ThemeChooser from '#lib/components/ThemeChooser.svelte';
  import { ARTICLE_OPEN_MODES } from '#lib/constants/article-open-modes.ts';
  import { fly } from 'svelte/transition';
  import { fetchWithCsrf } from '#lib/client/csrf.ts';

  let { data, form } = $props();
  let rankingProvider = $state<'jev' | 'subq'>('jev');
  let savedRankingProvider = $state<'jev' | 'subq'>('jev');
  let rankingProviderAvailability = $derived(
    data.rankingProviderConfigured ?? { jev: false, subq: false },
  );
  let savingRankingProvider = $state(false);
  let confirmingProviderChange = $state(false);
  let rankingProviderMessage = $state('');

  $effect(() => {
    const currentProvider = data.rankingProvider ?? 'jev';
    rankingProvider = currentProvider;
    savedRankingProvider = currentProvider;
  });

  async function promptRankingProviderSwitch() {
    if (savingRankingProvider || rankingProvider === savedRankingProvider)
      return;
    confirmingProviderChange = true;
    await tick();
    document.getElementById('confirm-ranking-provider-switch')?.focus();
  }

  async function cancelRankingProviderSwitch() {
    confirmingProviderChange = false;
    await tick();
    document.getElementById('save-ranking-provider-trigger')?.focus();
  }

  async function saveRankingProvider() {
    savingRankingProvider = true;
    confirmingProviderChange = false;
    rankingProviderMessage = '';
    try {
      const response = await fetchWithCsrf('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'ranking_provider',
          value: rankingProvider,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        rankingProviderMessage =
          result.message || result.error || 'Could not save ranking provider.';
        return;
      }
      savedRankingProvider = result.provider || rankingProvider;
      rankingProviderMessage = result.configured
        ? result.message || 'Ranking provider saved.'
        : 'Provider saved, but its server-side API key is missing. Scores remain queued until a key is configured.';
    } catch {
      rankingProviderMessage = 'Could not save ranking provider.';
    } finally {
      savingRankingProvider = false;
    }
  }

  let importingOpml = $state(false);

  function importOpml() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.opml,.xml';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || importingOpml) return;
      importingOpml = true;
      try {
        const text = await file.text();
        const response = await fetchWithCsrf('/api/opml/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ opml: text }),
        });
        const result = await response.json();
        if (!response.ok) {
          addToast(result.error || 'Could not import OPML.', 'error');
          return;
        }
        const errors = result.errors?.length ?? 0;
        const imported = result.imported
          ? `Imported ${result.imported} feed${result.imported === 1 ? '' : 's'}.`
          : 'No new feeds were imported.';
        if (errors > 0) {
          addToast(
            `${imported} ${result.errors[0]}`,
            result.imported ? 'warning' : 'error',
          );
        } else {
          addToast(imported, result.imported ? 'success' : 'info');
        }
        if (result.imported > 0) await refreshAll();
      } catch {
        addToast('Could not import OPML. Please try again.', 'error');
      } finally {
        importingOpml = false;
      }
    };
    input.click();
  }
</script>

<svelte:head>
  <title>Settings · Feed Me Maybe</title>
</svelte:head>

<div class="space-y-5">
  <div class="mb-1">
    <p class="text-sm text-surface-300">
      Keep the essentials close. Less-frequently changed options are grouped
      below.
    </p>
  </div>

  <section
    class="glass-card p-5"
    aria-labelledby="ranking-provider-heading"
    in:fly={{ y: 12, duration: 300, delay: 30 }}
  >
    <div class="mb-4">
      <h2
        id="ranking-provider-heading"
        class="text-sm font-semibold text-surface-100"
      >
        Article ranking provider
      </h2>
      <p class="mt-1 text-xs leading-5 text-surface-300">
        Choose which model produces personalized article scores. Changing the
        provider clears old model scores and queues articles for rescoring. The
        app combines provider scores with local heuristic scores.
      </p>
    </div>
    <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
      <label class="label flex-1">
        <span class="mb-1 block text-xs text-surface-300">Provider</span>
        <select
          class="select glass-input text-sm"
          bind:value={rankingProvider}
          aria-describedby="ranking-provider-status"
        >
          <option value="jev"
            >Jev · {rankingProviderAvailability.jev
              ? 'configured'
              : 'API key missing'}</option
          >
          <option value="subq"
            >SubQ Snap · {rankingProviderAvailability.subq
              ? 'configured'
              : 'API key missing'}</option
          >
        </select>
      </label>
      <button
        type="button"
        id="save-ranking-provider-trigger"
        class="btn preset-filled-primary-500 inline-flex min-h-11 items-center justify-center text-sm"
        onclick={promptRankingProviderSwitch}
        disabled={savingRankingProvider ||
          rankingProvider === savedRankingProvider}
      >
        {savingRankingProvider ? 'Saving…' : 'Save provider'}
      </button>
    </div>
    {#if confirmingProviderChange && rankingProvider !== savedRankingProvider}
      <div
        class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded border border-warning-500/30 bg-warning-500/10 p-3 text-xs text-surface-200"
        role="group"
        aria-label="Confirm ranking provider switch"
      >
        <span>
          Switch to {rankingProvider === 'subq' ? 'SubQ Snap' : 'Jev'}? Existing
          provider scores will be cleared and queued for recalculation.
        </span>
        <div class="flex items-center gap-2">
          <button
            type="button"
            id="confirm-ranking-provider-switch"
            class="btn preset-filled-primary-500 px-3 py-1.5 text-xs"
            onclick={saveRankingProvider}
            disabled={savingRankingProvider}
          >
            Confirm switch
          </button>
          <button
            type="button"
            class="btn preset-tonal px-3 py-1.5 text-xs"
            onclick={cancelRankingProviderSwitch}
            disabled={savingRankingProvider}
          >
            Cancel
          </button>
        </div>
      </div>
    {/if}
    <p
      id="ranking-provider-status"
      class="mt-3 text-xs leading-5 text-surface-300"
      aria-live="polite"
    >
      {#if rankingProviderMessage}
        {rankingProviderMessage}
      {:else if !rankingProviderAvailability[rankingProvider]}
        The selected provider has no server-side API key configured. Scores will
        remain queued until its key is available.
      {:else}
        Ready to score articles with {rankingProvider === 'subq'
          ? 'SubQ Snap'
          : 'Jev'}.
      {/if}
    </p>
  </section>

  <section
    class="glass-card p-5"
    aria-labelledby="appearance-heading"
    in:fly={{ y: 12, duration: 300 }}
  >
    <div class="mb-4 flex items-start justify-between gap-4">
      <div>
        <h2
          id="appearance-heading"
          class="text-sm font-semibold text-surface-100"
        >
          Appearance
        </h2>
        <p class="mt-1 text-xs text-surface-300">
          Choose the color system for the app.
        </p>
      </div>
      <span class="shrink-0 text-xs text-surface-300">22 themes</span>
    </div>
    <ThemeChooser />
  </section>

  <section
    class="glass-card p-5"
    aria-labelledby="reading-heading"
    in:fly={{ y: 12, duration: 300, delay: 60 }}
  >
    <div class="mb-4">
      <h2 id="reading-heading" class="text-sm font-semibold text-surface-100">
        Reading
      </h2>
      <p class="mt-1 text-xs text-surface-300">
        Choose how articles open and leave the list.
      </p>
    </div>
    <form
      method="POST"
      action="?/updateArticleSettings"
      use:enhance
      class="space-y-4"
      aria-describedby={form?.action === 'updateArticleSettings' && form?.error
        ? 'article-settings-error'
        : undefined}
    >
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label class="label">
          <span class="mb-1 block text-xs text-surface-300"
            >Default article open mode</span
          >
          <select
            id="article-open-mode"
            name="openMode"
            class="select glass-input text-sm"
            value={data.articleOpenMode}
            required
            aria-invalid={form?.action === 'updateArticleSettings' &&
            form?.field === 'openMode'
              ? 'true'
              : undefined}
            aria-describedby={form?.action === 'updateArticleSettings' &&
            form?.error
              ? 'article-settings-error'
              : undefined}
          >
            {#each ARTICLE_OPEN_MODES as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
        <label class="flex min-h-11 items-center gap-3 md:pt-5">
          <input
            type="checkbox"
            name="hideOnOpen"
            checked={data.hideOnOpen}
            class="checkbox"
            id="hideOnOpen"
          />
          <span class="text-sm text-surface-200"
            >Hide article after opening</span
          >
        </label>
      </div>
      {#if form?.action === 'updateArticleSettings' && form?.error}
        <p
          id="article-settings-error"
          class="text-sm text-error-300"
          role="alert"
        >
          {form.error}
        </p>
      {/if}
      <button
        type="submit"
        class="btn preset-filled-primary-500 inline-flex min-h-11 items-center gap-2 text-sm"
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
          ><path
            d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"
          /><polyline points="17 21 17 13 7 13 7 21" /><polyline
            points="7 3 7 8 15 8"
          /></svg
        >
        Save reading settings
      </button>
    </form>
  </section>

  <details class="glass-card p-5" in:fly={{ y: 12, duration: 300, delay: 100 }}>
    <summary
      class="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4"
    >
      <span>
        <span class="block text-sm font-semibold text-surface-100"
          >Sync and polling</span
        >
        <span class="mt-1 block text-xs text-surface-300"
          >Every {data.pollInterval} minutes · adaptive polling on</span
        >
      </span>
      <span class="text-lg text-surface-300" aria-hidden="true">+</span>
    </summary>
    <div class="mt-5 border-t border-white/10 pt-5">
      <form
        method="POST"
        action="?/updatePolling"
        use:enhance
        class="flex flex-col gap-4 sm:flex-row sm:items-end"
        aria-describedby={form?.action === 'updatePolling' && form?.error
          ? 'poll-interval-error'
          : undefined}
      >
        <label class="label flex-1">
          <span class="mb-1 block text-xs text-surface-300"
            >Global poll interval (minutes)</span
          >
          <input
            id="poll-interval"
            name="interval"
            type="number"
            min="1"
            max="1440"
            step="1"
            value={data.pollInterval}
            class="input glass-input text-sm"
            required
            aria-invalid={form?.action === 'updatePolling' &&
            form?.field === 'interval'
              ? 'true'
              : undefined}
            aria-describedby={form?.action === 'updatePolling' && form?.error
              ? 'poll-interval-help poll-interval-error'
              : 'poll-interval-help'}
          />
          <span
            id="poll-interval-help"
            class="mt-1 block text-xs text-surface-300"
          >
            Enter a whole number from 1 to 1440 minutes.
          </span>
        </label>
        <button
          type="submit"
          class="btn preset-filled-primary-500 inline-flex min-h-11 items-center justify-center gap-2 text-sm"
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
            ><path
              d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"
            /><polyline points="17 21 7 21 7 13 17 13 17 21" /><polyline
              points="7 3 7 8 15 8"
            /></svg
          >
          Save
        </button>
        {#if form?.action === 'updatePolling' && form?.error}
          <p
            id="poll-interval-error"
            class="text-sm text-error-300"
            role="alert"
          >
            {form.error}
          </p>
        {/if}
      </form>
      <p class="mt-3 text-xs leading-5 text-surface-300">
        Feeds are polled every {data.pollInterval} minutes. Feeds that have not changed
        in a while are polled less often to save bandwidth.
      </p>
    </div>
  </details>

  <details class="glass-card p-5" in:fly={{ y: 12, duration: 300, delay: 140 }}>
    <summary
      class="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4"
    >
      <span>
        <span class="block text-sm font-semibold text-surface-100"
          >Data and privacy</span
        >
        <span class="mt-1 block text-xs text-surface-300"
          >Import, export, and server privacy details</span
        >
      </span>
      <span class="text-lg text-surface-300" aria-hidden="true">+</span>
    </summary>
    <div class="mt-5 space-y-5 border-t border-white/10 pt-5">
      <section aria-labelledby="password-heading">
        <h3
          id="password-heading"
          class="text-sm font-semibold text-surface-100"
        >
          App password
        </h3>
        <p class="mt-1 text-xs leading-5 text-surface-300">
          Password is configured via the APP_PASSWORD environment variable.
        </p>
      </section>

      <section aria-labelledby="privacy-heading">
        <h3 id="privacy-heading" class="text-sm font-semibold text-surface-100">
          Privacy
        </h3>
        <p class="mt-1 text-xs leading-5 text-surface-300">
          The app stores its data in SQLite on this server. RSS/Atom sources are
          contacted to fetch feeds. If configured, Jev or SubQ receives article
          details and reader preference signals to produce personalized scores;
          your AI model provider receives article text for enrichment. Webhook
          destinations receive the event payloads you select. The model catalog
          and provider logos load from models.dev. Review these services and
          destinations before configuring them.
        </p>
      </section>

      <section aria-labelledby="opml-heading">
        <h3 id="opml-heading" class="text-sm font-semibold text-surface-100">
          OPML import and export
        </h3>
        <p class="mt-1 text-xs text-surface-300">
          Move your feed list to or from another reader, or manage your
          subscriptions.
        </p>
        <div class="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <a href="/feeds" class="action-btn min-h-11 px-3 py-2 no-underline">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
              ><path d="M4 11a9 9 0 0 1 9 9" /><path
                d="M4 4a16 16 0 0 1 16 16"
              /><circle cx="5" cy="19" r="1" /></svg
            >
            Manage feeds
          </a>
          <button
            type="button"
            class="action-btn min-h-11 px-3 py-2"
            onclick={importOpml}
            disabled={importingOpml}
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
              ><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline
                points="17 8 12 3 7 8"
              /><line x1="12" y1="3" x2="12" y2="15" /></svg
            >
            {importingOpml ? 'Importing…' : 'Import OPML'}
          </button>
          <a
            href="/api/opml/export"
            class="btn preset-filled-primary-500 inline-flex min-h-11 items-center justify-center gap-2 text-xs no-underline"
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
              ><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline
                points="7 10 12 15 17 10"
              /><line x1="12" y1="15" x2="12" y2="3" /></svg
            >
            Export OPML
          </a>
        </div>
      </section>
    </div>
  </details>
</div>
