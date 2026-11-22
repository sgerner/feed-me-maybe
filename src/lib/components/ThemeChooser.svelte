<script lang="ts">
  import { themeStore } from '#lib/stores/theme.svelte.ts';

  const themes = [
    { name: 'cerberus', label: 'Cerberus' },
    { name: 'modern', label: 'Modern' },
    { name: 'catppuccin', label: 'Catppuccin' },
    { name: 'rose', label: 'Rose' },
    { name: 'pine', label: 'Pine' },
    { name: 'seafoam', label: 'Seafoam' },
  ];

  let currentTheme = $derived(
    themes.find((theme) => theme.name === themeStore.current) ?? themes[0],
  );

  function selectTheme(name: string) {
    themeStore.set(name);
  }
</script>

<div class="space-y-4">
  <div
    class="flex flex-wrap items-center justify-between gap-2 text-xs text-surface-300"
  >
    <p>
      Current theme: <span class="font-semibold text-surface-200"
        >{currentTheme.label}</span
      >
    </p>
    <p>Choose a preview to apply it instantly.</p>
  </div>

  <div id="theme-collection" class="grid grid-cols-2 gap-3 sm:grid-cols-3">
    {#each themes as { name, label } (name)}
      <button
        type="button"
        data-theme={name}
        aria-pressed={currentTheme.name === name}
        class="group relative flex min-h-28 flex-col gap-3 p-3 text-left transition-all duration-300 glass-card glass-card-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400"
        style={currentTheme.name === name
          ? 'border-color: var(--color-primary-300); box-shadow: 0 0 0 1px var(--color-primary-300); background: color-mix(in oklch, var(--color-primary-500) 14%, transparent);'
          : ''}
        onclick={() => selectTheme(name)}
      >
        <div class="flex w-full items-center justify-between gap-2">
          <span
            class="text-[10px] font-bold uppercase tracking-widest transition-colors {currentTheme.name ===
            name
              ? 'text-primary-300'
              : 'text-surface-200 group-hover:text-surface-100'}"
          >
            {label}
          </span>
          {#if currentTheme.name === name}
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
          class="flex w-full gap-1 overflow-hidden rounded-[2px] border border-white/15 bg-black/20 p-1"
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
    {/each}
  </div>
</div>
