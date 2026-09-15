<script lang="ts">
  import { fly } from 'svelte/transition';
  import { fetchWithCsrf } from '$lib/client/csrf';

  let step = $state(1);
  const totalSteps = 2;
  let feedUrl = $state('');
  let feedTitle = $state('');
  let loading = $state(false);
  let importing = $state(false);
  let error = $state('');
  let opmlMessage = $state('');

  function finishFeeds() {
    step = 2;
    error = '';
  }

  async function addFeed() {
    if (!feedUrl.trim()) return;

    loading = true;
    error = '';
    try {
      const res = await fetchWithCsrf('/api/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: feedUrl.trim(), title: feedTitle.trim() }),
      });
      if (!res.ok) {
        const d = await res.json();
        error = d.error || 'Failed to add feed';
        return;
      }
      feedUrl = '';
      feedTitle = '';
      finishFeeds();
    } catch {
      error = 'Connection error';
    } finally {
      loading = false;
    }
  }

  async function importOpml() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.opml,.xml';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      importing = true;
      error = '';
      opmlMessage = '';

      try {
        const text = await file.text();
        const res = await fetchWithCsrf('/api/opml/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ opml: text }),
        });

        if (!res.ok) {
          const d = await res.json();
          error = d.error || 'Failed to import OPML';
          return;
        }

        const result = await res.json();
        opmlMessage =
          result.imported > 0
            ? `Imported ${result.imported} feed${result.imported === 1 ? '' : 's'}.`
            : 'No new feeds were imported.';
        finishFeeds();
      } catch {
        error = 'Connection error';
      } finally {
        importing = false;
      }
    };
    input.click();
  }

  function skipFeeds() {
    finishFeeds();
  }

  async function finishSetup() {
    loading = true;
    await fetchWithCsrf('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'setup_complete', value: 'true' }),
    });
    window.location.href = '/';
  }
</script>

<div class="container mx-auto max-w-lg px-4 py-8 sm:py-10">
  <div class="mb-8 flex items-center justify-between gap-4">
    <p
      class="text-xs font-semibold uppercase tracking-[0.2em] text-surface-400"
    >
      Set up Feed Me Maybe
    </p>
    <p class="text-xs text-surface-400" aria-live="polite">
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

      <form
        class="space-y-4"
        onsubmit={(event) => {
          event.preventDefault();
          void addFeed();
        }}
      >
        <label class="label block">
          <span class="mb-1 block text-sm font-medium text-surface-200"
            >Feed URL</span
          >
          <input
            id="feed-url"
            name="feedUrl"
            type="url"
            bind:value={feedUrl}
            placeholder="https://example.com/feed.xml"
            autocomplete="url"
            class="input glass-input w-full"
            aria-describedby="feed-url-help"
            required
          />
          <span id="feed-url-help" class="mt-1 block text-xs text-surface-400">
            RSS, website, Reddit community, search, or post URLs work too.
          </span>
        </label>

        <label class="label block">
          <span class="mb-1 block text-sm font-medium text-surface-200">
            Feed title <span class="font-normal text-surface-400"
              >(optional)</span
            >
          </span>
          <input
            id="feed-title"
            name="feedTitle"
            type="text"
            bind:value={feedTitle}
            placeholder="Use the feed's title"
            autocomplete="off"
            class="input glass-input w-full"
          />
        </label>

        {#if error}
          <div
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
              aria-hidden="true"
              ><circle cx="12" cy="12" r="10" /><line
                x1="12"
                y1="8"
                x2="12"
                y2="12"
              /><line x1="12" y1="16" x2="12.01" y2="16" /></svg
            >
            {error}
          </div>
        {/if}

        {#if opmlMessage}
          <div
            class="px-3 py-2 text-sm text-success-300"
            role="status"
            style="background: color-mix(in oklch, var(--color-success-500) 10%, transparent); border: 1px solid color-mix(in oklch, var(--color-success-500) 20%, transparent); border-radius: 2px;"
          >
            {opmlMessage}
          </div>
        {/if}

        <button
          type="submit"
          class="btn preset-filled-primary-500 inline-flex min-h-11 w-full items-center justify-center gap-2"
          disabled={loading || importing || !feedUrl.trim()}
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
            Adding feed...
          {:else}
            Add feed
          {/if}
        </button>
      </form>

      <div
        class="mt-5 flex flex-col gap-3 border-t border-white/10 pt-5 sm:flex-row sm:items-center sm:justify-between"
      >
        <button
          type="button"
          class="action-btn min-h-11 px-4 py-2"
          onclick={importOpml}
          disabled={loading || importing}
        >
          {#if importing}Importing...{:else}Import OPML{/if}
        </button>
        <button
          type="button"
          class="min-h-11 px-2 py-2 text-sm text-surface-300 underline decoration-surface-500 underline-offset-4 hover:text-surface-100"
          onclick={skipFeeds}
          disabled={loading || importing}
        >
          I'll add feeds later
        </button>
      </div>
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
        Your feeds are ready. AI summaries and recommendations are optional—you
        can configure them later in Settings.
      </p>
      <div
        class="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center"
      >
        <button
          type="button"
          class="btn preset-filled-primary-500 inline-flex min-h-11 items-center justify-center gap-2"
          onclick={finishSetup}
          disabled={loading}
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
        <a
          href="/settings/ai"
          class="min-h-11 px-3 py-2 text-sm text-surface-300 underline decoration-surface-500 underline-offset-4 hover:text-surface-100"
        >
          Configure AI later
        </a>
      </div>
      <p class="mt-5 text-xs text-surface-400">
        You can also add more feeds anytime from the Feeds page.
      </p>
    </div>
  {/if}
</div>
