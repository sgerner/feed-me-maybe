<script lang="ts">
  import { themeStore } from '$lib/stores/theme.svelte';

  const themes = [
    { name: 'catppuccin', label: 'Catppuccin' },
    { name: 'cerberus', label: 'Cerberus' },
    { name: 'concord', label: 'Concord' },
    { name: 'crimson', label: 'Crimson' },
    { name: 'fennec', label: 'Fennec' },
    { name: 'hamlindigo', label: 'Hamlindigo' },
    { name: 'legacy', label: 'Legacy' },
    { name: 'mint', label: 'Mint' },
    { name: 'modern', label: 'Modern' },
    { name: 'mona', label: 'Mona' },
    { name: 'nosh', label: 'Nosh' },
    { name: 'nouveau', label: 'Nouveau' },
    { name: 'pine', label: 'Pine' },
    { name: 'reign', label: 'Reign' },
    { name: 'rocket', label: 'Rocket' },
    { name: 'rose', label: 'Rose' },
    { name: 'sahara', label: 'Sahara' },
    { name: 'seafoam', label: 'Seafoam' },
    { name: 'terminus', label: 'Terminus' },
    { name: 'vintage', label: 'Vintage' },
    { name: 'vox', label: 'Vox' },
    { name: 'wintry', label: 'Wintry' },
  ];

  const featuredThemeNames = [
    'cerberus',
    'modern',
    'catppuccin',
    'rose',
    'pine',
    'seafoam',
  ];
  let showAllThemes = $state(false);
  let currentTheme = $derived(
    themes.find((theme) => theme.name === themeStore.current) ?? themes[0],
  );

  function selectTheme(name: string) {
    themeStore.set(name);
    if (!featuredThemeNames.includes(name)) showAllThemes = true;
  }
</script>

<div class="space-y-4">
  <div
    class="flex flex-wrap items-center justify-between gap-2 text-xs text-surface-400"
  >
    <p>
      Current theme: <span class="font-semibold text-surface-200"
        >{currentTheme.label}</span
      >
    </p>
    <p>Choose a preview to apply it instantly.</p>
  </div>

  <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
    {#each themes as { name, label } (name)}
      {#if showAllThemes || featuredThemeNames.includes(name)}
        <button
          type="button"
          data-theme={name}
          aria-label={`Use ${label} theme`}
          aria-pressed={themeStore.current === name}
          class="group relative flex min-h-28 flex-col gap-3 p-3 text-left transition-all duration-300 glass-card glass-card-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400"
          style={themeStore.current === name
            ? 'border-color: color-mix(in oklch, var(--color-primary-500) 40%, transparent); background: color-mix(in oklch, var(--color-primary-500) 8%, transparent);'
            : ''}
          onclick={() => selectTheme(name)}
        >
          <div class="flex w-full items-center justify-between gap-2">
            <span
              class="text-[10px] font-bold uppercase tracking-widest transition-colors {themeStore.current ===
              name
                ? 'text-primary-400'
                : 'text-surface-400 group-hover:text-surface-200'}"
            >
              {label}
            </span>
            {#if themeStore.current === name}
              <span
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-500 text-white"
                aria-hidden="true"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="4"><path d="M20 6 9 17l-5-5" /></svg
                >
              </span>
            {/if}
          </div>

          <div
            class="flex w-full gap-1 overflow-hidden rounded-[2px] border border-white/5 bg-black/20 p-1"
            aria-hidden="true"
          >
            <div
              class="h-4 flex-1 rounded-[1px]"
              style="background-color: var(--color-primary-500)"
            ></div>
            <div
              class="h-4 flex-1 rounded-[1px]"
              style="background-color: var(--color-secondary-500)"
            ></div>
            <div
              class="h-4 flex-1 rounded-[1px]"
              style="background-color: var(--color-tertiary-500)"
            ></div>
            <div
              class="h-4 flex-1 rounded-[1px]"
              style="background-color: var(--color-surface-500)"
            ></div>
          </div>
        </button>
      {/if}
    {/each}
  </div>

  <button
    type="button"
    class="flex min-h-11 w-full items-center justify-between gap-3 border-t border-white/10 pt-4 text-left text-sm text-surface-300 hover:text-surface-100"
    aria-expanded={showAllThemes}
    onclick={() => (showAllThemes = !showAllThemes)}
  >
    <span>
      {#if showAllThemes}Hide additional themes{:else}Browse all {themes.length} themes{/if}
    </span>
    <svg
      class:rotate-180={showAllThemes}
      class="shrink-0 transition-transform"
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg
    >
  </button>
  {#if showAllThemes}
    <p class="text-xs text-surface-400">
      Every theme remains available here; selecting one applies it immediately.
    </p>
  {/if}
</div>
