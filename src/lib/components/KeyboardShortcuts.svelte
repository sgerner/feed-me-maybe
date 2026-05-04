<script lang="ts">
  import { fade, fly } from 'svelte/transition';

  let { open = $bindable(false) } = $props();

  const shortcuts = [
    { key: 'j', description: 'Focus next article' },
    { key: 'k', description: 'Focus previous article' },
    { key: 'o', description: 'Open focused article' },
    { key: 'h', description: 'Hide focused article' },
    { key: 's', description: 'Save focused article' },
    { key: 'Enter', description: 'Open article (when focused)' },
    { key: 'Space', description: 'Open article (when focused)' },
  ];
</script>

{#if open}
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-md"
    transition:fade={{ duration: 200 }}
    onclick={() => (open = false)}
    role="presentation"
  >
    <div
      class="glass-card w-full max-w-sm p-6 shadow-2xl"
      transition:fly={{ y: 20, duration: 300 }}
      onclick={(e) => e.stopPropagation()}
      role="presentation"
    >
      <div class="mb-6 flex items-center justify-between">
        <h3 class="text-lg font-bold">Keyboard Shortcuts</h3>
        <button
          class="btn-icon"
          onclick={() => (open = false)}
          aria-label="Close"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg
          >
        </button>
      </div>

      <div class="space-y-4">
        {#each shortcuts as shortcut}
          <div class="flex items-center justify-between">
            <span class="text-sm text-surface-300">{shortcut.description}</span>
            <kbd
              class="rounded border border-white/10 bg-white/5 px-2 py-1 text-xs font-mono text-primary-400"
            >
              {shortcut.key}
            </kbd>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  kbd {
    box-shadow: 0 2px 0 0 rgba(0, 0, 0, 0.2);
  }
</style>
