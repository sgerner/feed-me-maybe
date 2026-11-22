<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { fly } from 'svelte/transition';
  import { fetchWithCsrf } from '#lib/client/csrf.ts';
  import FeedSubscriptionForm from '#lib/components/FeedSubscriptionForm.svelte';

  let step = $state(1);
  const totalSteps = 2;
  let loading = $state(false);
  let importing = $state(false);
  let opmlError = $state('');
  let feedImportStatus = $state('');
  let feedImportStatusKind = $state<'success' | 'warning' | 'error' | 'info'>(
    'info',
  );
  let setupError = $state('');
  const existingCategories = $derived<string[]>(
    Array.isArray(page.data.feedCategories) ? page.data.feedCategories : [],
  );

  function finishFeeds(preserveImportStatus = false) {
    step = 2;
    opmlError = '';
    setupError = '';
    if (!preserveImportStatus) feedImportStatus = '';
  }

  async function importOpml() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.opml,.xml';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      importing = true;
      opmlError = '';

      try {
        const text = await file.text();
        const res = await fetchWithCsrf('/api/opml/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ opml: text }),
        });

        if (!res.ok) {
          const d = await res.json();
          opmlError = d.error || 'Failed to import OPML';
          return;
        }

        const result = await res.json();
        const importedCount = Number.isInteger(result.imported)
          ? result.imported
          : 0;
        const importErrors = Array.isArray(result.errors)
          ? result.errors.filter(
              (message: unknown) => typeof message === 'string',
            )
          : [];

        if (importErrors.length > 0) {
          const firstError = importErrors[0];
          feedImportStatus =
            importedCount > 0
              ? `Imported ${importedCount} feed${importedCount === 1 ? '' : 's'}. ${importErrors.length} could not be imported: ${firstError}`
              : `No feeds were imported. ${importErrors.length} could not be imported: ${firstError}`;
          feedImportStatusKind = importedCount > 0 ? 'warning' : 'error';
        } else if (importedCount > 0) {
          feedImportStatus = `Imported ${importedCount} feed${importedCount === 1 ? '' : 's'}.`;
          feedImportStatusKind = 'success';
        } else {
          feedImportStatus = 'No new feeds were imported.';
          feedImportStatusKind = 'info';
        }

        if (importedCount > 0) finishFeeds(true);
      } catch {
        opmlError = 'Connection error';
      } finally {
        importing = false;
      }
    };
    input.click();
  }

  async function finishSetup(destination: string) {
    if (loading) return;
    loading = true;
    setupError = '';

    try {
      const response = await fetchWithCsrf('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'setup_complete', value: 'true' }),
      });
      if (!response.ok) throw new Error('Setup could not be saved');
      await goto(destination, { refreshAll: true });
    } catch {
      setupError = 'Could not finish setup. Please try again.';
    } finally {
      loading = false;
    }
  }
</script>

<svelte:head>
  <title>Get Started · Feed Me Maybe</title>
</svelte:head>

<div class="container mx-auto max-w-lg px-4 py-8 sm:py-10">
  <div class="mb-8 flex items-center justify-between gap-4">
    <p
      class="text-xs font-semibold uppercase tracking-[0.2em] text-surface-300"
    >
      Set up Feed Me Maybe
    </p>
    <p class="text-xs text-surface-300" aria-live="polite">
      Step {step} of {totalSteps}
    </p>
  </div>

  <ol class="sr-only" aria-label="Setup progress">
    <li aria-current={step === 1 ? 'step' : undefined}>Add feeds</li>
    <li aria-current={step === 2 ? 'step' : undefined}>Start reading</li>
  </ol>

  {#if step === 1}
    <div class="glass-card p-6 md:p-8" in:fly={{ y: 16, duration: 350 }}>
      <div class="mb-6 flex items-start gap-4">
        <div
          class="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
          style="background: color-mix(in oklch, var(--color-primary-500) 12%, transparent); color: var(--color-primary-400);"
          aria-hidden="true"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path d="M4 11a9 9 0 0 1 9 9" /><path
              d="M4 4a16 16 0 0 1 16 16"
            /><circle cx="5" cy="19" r="1" />
          </svg>
        </div>
        <div>
          <h1 class="gradient-text text-2xl font-bold">Add your feeds</h1>
          <p class="mt-2 text-sm text-surface-300">
            Add one feed now, or import your existing list. You can add more
            whenever you want.
          </p>
        </div>
      </div>

      <FeedSubscriptionForm
        idPrefix="onboarding-feed"
        categories={existingCategories}
        submitLabel="Add feed"
        submittingLabel="Adding feed..."
        disabled={importing}
        onBusyChange={(busy) => {
          loading = busy;
        }}
        onSuccess={() => {
          finishFeeds();
        }}
      />

      <div
        class="mt-5 flex flex-col gap-3 border-t border-white/10 pt-5 sm:flex-row sm:items-center sm:justify-between"
      >
        <button
          type="button"
          class="action-btn min-h-11 px-4 py-2"
          onclick={importOpml}
          disabled={loading || importing}
          aria-describedby={opmlError ? 'opml-error' : undefined}
        >
          {#if importing}Importing...{:else}Import OPML{/if}
        </button>
        <button
          type="button"
          class="min-h-11 px-2 py-2 text-sm text-surface-300 underline decoration-surface-500 underline-offset-4 hover:text-surface-100"
          onclick={() => finishFeeds()}
          disabled={loading || importing}
        >
          I'll add feeds later
        </button>
      </div>
      {#if feedImportStatus}
        <p
          class="mt-3 text-sm {feedImportStatusKind === 'error'
            ? 'text-error-300'
            : 'text-surface-200'}"
          role={feedImportStatusKind === 'warning' ||
          feedImportStatusKind === 'error'
            ? 'alert'
            : 'status'}
        >
          {feedImportStatus}
        </p>
      {/if}
      {#if opmlError}
        <p id="opml-error" class="mt-3 text-sm text-error-300" role="alert">
          {opmlError}
        </p>
      {/if}
    </div>
  {:else}
    <div
      class="glass-card p-6 text-center md:p-8"
      in:fly={{ y: 16, duration: 350 }}
    >
      <div
        class="mx-auto mb-6 inline-flex h-16 w-16 items-center justify-center rounded-full"
        style="background: color-mix(in oklch, var(--color-success-500) 12%, transparent); box-shadow: 0 0 30px -5px color-mix(in oklch, var(--color-success-500) 30%, transparent); color: var(--color-success-400);"
        aria-hidden="true"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="34"
          height="34"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"><path d="M20 6 9 17l-5-5" /></svg
        >
      </div>
      <h1 class="text-2xl font-bold text-surface-50">You're ready to read</h1>
      <p class="mx-auto mt-4 max-w-sm text-surface-300">
        AI summaries and recommendations are optional. You can configure them in
        Settings.
      </p>
      {#if feedImportStatus}
        <p
          class="mx-auto mt-4 max-w-lg text-sm {feedImportStatusKind === 'error'
            ? 'text-error-300'
            : 'text-surface-200'}"
          role={feedImportStatusKind === 'warning' ||
          feedImportStatusKind === 'error'
            ? 'alert'
            : 'status'}
        >
          {feedImportStatus}
        </p>
      {/if}
      <div
        class="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center"
      >
        <button
          type="button"
          class="btn preset-filled-primary-500 inline-flex min-h-11 items-center justify-center gap-2"
          onclick={() => finishSetup('/')}
          disabled={loading}
          aria-describedby={setupError ? 'setup-error' : undefined}
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
            Opening your reader...
          {:else}
            Start reading
          {/if}
        </button>
        <button
          type="button"
          onclick={() => finishSetup('/settings/ai')}
          disabled={loading}
          class="min-h-11 px-3 py-2 text-sm text-surface-300 underline decoration-surface-500 underline-offset-4 hover:text-surface-100"
          aria-describedby={setupError ? 'setup-error' : undefined}
        >
          Configure AI
        </button>
      </div>
      {#if setupError}
        <p id="setup-error" class="mt-4 text-sm text-error-300" role="alert">
          {setupError}
        </p>
      {/if}
      <p class="mt-5 text-xs text-surface-300">
        You can also add more feeds anytime from the Feeds page.
      </p>
    </div>
  {/if}
</div>
