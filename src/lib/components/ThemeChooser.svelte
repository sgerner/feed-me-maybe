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
</script>

<div
  class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5"
>
  {#each themes as { name, label }}
    <button
      type="button"
      data-theme={name}
      class="group relative flex flex-col gap-3 p-3 transition-all duration-300 glass-card glass-card-hover text-left"
      style={themeStore.current === name
        ? 'border-color: color-mix(in oklch, var(--color-primary-500) 40%, transparent); background: color-mix(in oklch, var(--color-primary-500) 8%, transparent);'
        : ''}
      onclick={() => themeStore.set(name)}
    >
      <!-- Header: Label and Checkmark -->
      <div class="flex items-center justify-between w-full">
        <span
          class="text-[10px] font-bold uppercase tracking-widest transition-colors {themeStore.current ===
          name
            ? 'text-primary-400'
            : 'text-surface-400 group-hover:text-surface-200'}"
        >
          {label}
        </span>
        {#if themeStore.current === name}
          <div
            class="flex h-4 w-4 items-center justify-center rounded-full bg-primary-500 text-white"
            style="box-shadow: 0 0 10px color-mix(in oklch, var(--color-primary-500) 50%, transparent)"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="4"><path d="M20 6 9 17l-5-5" /></svg
            >
          </div>
        {/if}
      </div>

      <!-- Color Palette Preview -->
      <div
        class="flex w-full gap-1 overflow-hidden rounded-[2px] p-1 bg-black/20 backdrop-blur-sm border border-white/5"
      >
        <div
          class="h-4 flex-1 rounded-[1px]"
          style="background-color: var(--color-primary-500)"
          title="Primary"
        ></div>
        <div
          class="h-4 flex-1 rounded-[1px]"
          style="background-color: var(--color-secondary-500)"
          title="Secondary"
        ></div>
        <div
          class="h-4 flex-1 rounded-[1px]"
          style="background-color: var(--color-tertiary-500)"
          title="Tertiary"
        ></div>
        <div
          class="h-4 flex-1 rounded-[1px]"
          style="background-color: var(--color-surface-500)"
          title="Surface"
        ></div>
      </div>

      <!-- Active Indicator Glow (Optional, subtle) -->
      {#if themeStore.current === name}
        <div
          class="absolute -inset-[1px] -z-10 rounded-[3px] bg-primary-500/20 blur-md transition-opacity"
        ></div>
      {/if}
    </button>
  {/each}
</div>
