<script lang="ts">
  import { enhance } from '$app/forms';
  import ThemeChooser from '$lib/components/ThemeChooser.svelte';
  import { fly, fade } from 'svelte/transition';
  let { data } = $props();

  async function importOpml() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.opml,.xml';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const res = await fetch('/api/opml/import', {
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
  <div
    class="glass-card glass-card-hover p-5"
    in:fly={{ y: 12, duration: 300 }}
  >
    <h2
      class="mb-4 flex items-center gap-2 text-sm font-semibold"
      style="color: var(--color-surface-100);"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        ><circle cx="12" cy="12" r="10" /><path
          d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"
        /><path d="M2 12h20" /></svg
      >
      Application Theme
    </h2>
    <ThemeChooser />
  </div>

  <div
    class="glass-card glass-card-hover p-5"
    in:fly={{ y: 12, duration: 300, delay: 60 }}
  >
    <h2
      class="mb-3 flex items-center gap-2 text-sm font-semibold"
      style="color: var(--color-surface-100);"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        ><circle cx="12" cy="12" r="10" /><polyline
          points="12 6 12 12 16 14"
        /></svg
      >
      Polling Configuration
    </h2>
    <form
      method="POST"
      action="?/updatePolling"
      use:enhance
      class="flex items-end gap-4"
    >
      <label class="label flex-1">
        <span
          class="mb-1 block text-xs"
          style="color: color-mix(in oklch, var(--color-surface-200) 55%, transparent);"
          >Global Poll Interval (minutes)</span
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
        class="btn preset-filled-primary-500 inline-flex items-center gap-2 text-sm"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          ><path
            d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"
          /><polyline points="17 21 17 13 7 13 7 21" /><polyline
            points="7 3 7 8 15 8"
          /></svg
        >
        Save
      </button>
    </form>
    <p
      class="mt-3 text-xs"
      style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);"
    >
      Feeds are polled every {data.pollInterval} minutes. Adaptive polling is enabled:
      feeds that haven't changed in a while will be polled less frequently to save
      bandwidth.
    </p>
  </div>

  <div
    class="glass-card glass-card-hover p-5"
    in:fly={{ y: 12, duration: 300, delay: 100 }}
  >
    <h2
      class="mb-4 flex items-center gap-2 text-sm font-semibold"
      style="color: var(--color-surface-100);"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        ><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path
          d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"
        /></svg
      >
      Article Reading
    </h2>
    <form
      method="POST"
      action="?/updateArticleSettings"
      use:enhance
      class="space-y-4"
    >
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label class="label">
          <span
            class="mb-1 block text-xs"
            style="color: color-mix(in oklch, var(--color-surface-200) 55%, transparent);"
            >Default Article Open Mode</span
          >
          <select
            name="openMode"
            class="select glass-input text-sm"
            value={data.articleOpenMode}
          >
            <option value="app">Fetch & Render (In-App)</option>
            <option value="iframe">Iframe (In-App)</option>
            <option value="proxy">Iframe via Proxy (Bypass Blocks)</option>
            <option value="tab">New Tab</option>
          </select>
        </label>
        <div class="flex items-center gap-3 pt-5">
          <input
            type="checkbox"
            name="hideOnOpen"
            checked={data.hideOnOpen}
            class="checkbox"
            id="hideOnOpen"
          />
          <label for="hideOnOpen" class="text-sm"
            >Hide article after opening</label
          >
        </div>
      </div>
      <button
        type="submit"
        class="btn preset-filled-primary-500 inline-flex items-center gap-2 text-sm"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          ><path
            d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"
          /><polyline points="17 21 17 13 7 13 7 21" /><polyline
            points="7 3 7 8 15 8"
          /></svg
        >
        Save Reading Settings
      </button>
    </form>
  </div>

  <div class="glass-card p-5" in:fly={{ y: 12, duration: 300, delay: 120 }}>
    <h2
      class="mb-2 flex items-center gap-2 text-sm font-semibold"
      style="color: var(--color-surface-100);"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        ><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path
          d="M7 11V7a5 5 0 0 1 10 0v4"
        /></svg
      >
      App Password
    </h2>
    <p
      class="text-xs"
      style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);"
    >
      Password is configured via the APP_PASSWORD environment variable.
    </p>
  </div>

  <div class="glass-card p-5" in:fly={{ y: 12, duration: 300, delay: 180 }}>
    <h2
      class="mb-2 flex items-center gap-2 text-sm font-semibold"
      style="color: var(--color-surface-100);"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        ><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg
      >
      Privacy Note
    </h2>
    <p
      class="text-xs"
      style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);"
    >
      This app stores all data locally in SQLite. No data is sent to external
      services except the AI provider you configure and RSS/Atom feed fetches.
      Your reading habits remain private to your server.
    </p>
  </div>

  <div
    class="glass-card glass-card-hover p-5"
    in:fly={{ y: 12, duration: 300, delay: 240 }}
  >
    <h2
      class="mb-2 flex items-center gap-2 text-sm font-semibold"
      style="color: var(--color-surface-100);"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        ><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline
          points="7 10 12 15 17 10"
        /><line x1="12" y1="15" x2="12" y2="3" /></svg
      >
      OPML Import/Export
    </h2>
    <p
      class="mb-4 text-xs"
      style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);"
    >
      Import or export your feeds as OPML.
    </p>
    <div class="flex gap-2">
      <input type="file" accept=".opml,.xml" id="opml-file" class="hidden" />
      <button class="action-btn px-3 py-2" onclick={importOpml}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          ><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline
            points="17 8 12 3 7 8"
          /><line x1="12" y1="3" x2="12" y2="15" /></svg
        >
        Import OPML
      </button>
      <a
        href="/api/opml/export"
        class="btn preset-filled-primary-500 inline-flex items-center gap-2 text-xs no-underline"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          ><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline
            points="7 10 12 15 17 10"
          /><line x1="12" y1="15" x2="12" y2="3" /></svg
        >
        Export OPML
      </a>
    </div>
  </div>
</div>
