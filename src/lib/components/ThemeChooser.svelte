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
    { name: 'wintry', label: 'Wintry' }
  ];
</script>

<div class="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
  {#each themes as { name, label }}
    <button
      type="button"
      class="relative flex items-center justify-between px-3 py-2.5 text-sm transition-all"
      style={themeStore.current === name
        ? 'background: color-mix(in oklch, var(--color-primary-500) 12%, transparent); border: 1px solid color-mix(in oklch, var(--color-primary-500) 30%, transparent); color: var(--color-primary-300); box-shadow: 0 0 16px -4px color-mix(in oklch, var(--color-primary-500) 25%, transparent); border-radius: 2px;'
        : 'background: color-mix(in oklch, var(--color-surface-100) 4%, transparent); border: 1px solid color-mix(in oklch, var(--color-surface-100) 5%, transparent); color: color-mix(in oklch, var(--color-surface-200) 65%, transparent); border-radius: 2px;'}
      onclick={() => themeStore.set(name)}
    >
      <span class="font-medium">{label}</span>
      {#if themeStore.current === name}
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg>
      {/if}
    </button>
  {/each}
</div>