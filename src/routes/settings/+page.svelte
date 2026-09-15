<script lang="ts">
  import { enhance } from '$app/forms';
  import ThemeChooser from '$lib/components/ThemeChooser.svelte';
  import { ARTICLE_OPEN_MODES } from '$lib/constants/article-open-modes';
  import { fly } from 'svelte/transition';
  import { fetchWithCsrf } from '$lib/client/csrf';

  let { data } = $props();

  async function importOpml() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.opml,.xml';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const res = await fetchWithCsrf('/api/opml/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opml: text }),
      });
      if (res.ok) {
        const result = await res.json();
        alert(
          `Imported ${result.imported} feeds. ${result.errors?.length || 0} errors.`,
        );
        window.location.reload();
      }
    };
    input.click();
  }
</script>

<div class="space-y-5">
  <div class="mb-1">
    <p class="text-sm text-surface-300">
      Keep the essentials close. Less-frequently changed options are grouped
      below.
    </p>
  </div>

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
        <p class="mt-1 text-xs text-surface-400">
          Choose the color system for the app.
        </p>
      </div>
      <span class="shrink-0 text-xs text-surface-400">22 themes</span>
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
      <p class="mt-1 text-xs text-surface-400">
        Choose how articles open and leave the list.
      </p>
    </div>
    <form
      method="POST"
      action="?/updateArticleSettings"
      use:enhance
      class="space-y-4"
    >
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label class="label">
          <span class="mb-1 block text-xs text-surface-300"
            >Default article open mode</span
          >
          <select
            name="openMode"
            class="select glass-input text-sm"
            value={data.articleOpenMode}
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
        <span class="mt-1 block text-xs text-surface-400"
          >Every {data.pollInterval} minutes · adaptive polling on</span
        >
      </span>
      <span class="text-lg text-surface-400" aria-hidden="true">+</span>
    </summary>
    <div class="mt-5 border-t border-white/10 pt-5">
      <form
        method="POST"
        action="?/updatePolling"
        use:enhance
        class="flex flex-col gap-4 sm:flex-row sm:items-end"
      >
        <label class="label flex-1">
          <span class="mb-1 block text-xs text-surface-300"
            >Global poll interval (minutes)</span
          >
          <input
            name="interval"
            type="number"
            min="1"
            max="1440"
            value={data.pollInterval}
            class="input glass-input text-sm"
          />
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
      </form>
      <p class="mt-3 text-xs leading-5 text-surface-400">
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
        <span class="mt-1 block text-xs text-surface-400"
          >Import, export, and server privacy details</span
        >
      </span>
      <span class="text-lg text-surface-400" aria-hidden="true">+</span>
    </summary>
    <div class="mt-5 space-y-5 border-t border-white/10 pt-5">
      <section aria-labelledby="password-heading">
        <h3
          id="password-heading"
          class="text-sm font-semibold text-surface-100"
        >
          App password
        </h3>
        <p class="mt-1 text-xs leading-5 text-surface-400">
          Password is configured via the APP_PASSWORD environment variable.
        </p>
      </section>

      <section aria-labelledby="privacy-heading">
        <h3 id="privacy-heading" class="text-sm font-semibold text-surface-100">
          Privacy
        </h3>
        <p class="mt-1 text-xs leading-5 text-surface-400">
          This app stores all data locally in SQLite. No data is sent to
          external services except the AI provider you configure and RSS/Atom
          feed fetches. Your reading habits remain private to your server.
        </p>
      </section>

      <section aria-labelledby="opml-heading">
        <h3 id="opml-heading" class="text-sm font-semibold text-surface-100">
          OPML import and export
        </h3>
        <p class="mt-1 text-xs text-surface-400">
          Move your feed list to or from another reader.
        </p>
        <div class="mt-4 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            class="action-btn min-h-11 px-3 py-2"
            onclick={importOpml}
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
            Import OPML
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
