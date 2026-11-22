<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import {
    getSingleKeyShortcutsEnabled,
    SINGLE_KEY_SHORTCUTS_CHANGE_EVENT,
    setSingleKeyShortcutsEnabled,
  } from '#lib/utils/keyboard-shortcuts.ts';

  let { open = $bindable(false), reader = false } = $props();
  let dialogEl = $state<HTMLDivElement | null>(null);
  let singleKeyShortcutsEnabled = $state(true);
  let previouslyFocused: HTMLElement | null = null;

  const shortcuts = $derived([
    { key: '?', description: 'Show keyboard shortcuts' },
    {
      key: 'j',
      description: reader ? 'Go to next article' : 'Focus next article',
    },
    {
      key: 'k',
      description: reader ? 'Go to previous article' : 'Focus previous article',
    },
    {
      key: 'o',
      description: reader ? 'Open original article' : 'Open focused article',
    },
    {
      key: 'h',
      description: reader
        ? 'Hide or restore this article'
        : 'Hide focused article',
    },
    {
      key: 's',
      description: reader
        ? 'Toggle saved for this article'
        : 'Save focused article',
    },
    {
      key: 'm',
      description: reader
        ? 'Toggle read / unread for this article'
        : 'Toggle read / unread for focused article',
    },
    ...(reader
      ? []
      : [
          { key: 'Enter', description: 'Open article (when focused)' },
          { key: 'Space', description: 'Open article (when focused)' },
        ]),
  ]);

  onMount(() => {
    const syncShortcutPreference = () => {
      singleKeyShortcutsEnabled = getSingleKeyShortcutsEnabled();
    };

    syncShortcutPreference();
    window.addEventListener(
      SINGLE_KEY_SHORTCUTS_CHANGE_EVENT,
      syncShortcutPreference,
    );

    return () => {
      window.removeEventListener(
        SINGLE_KEY_SHORTCUTS_CHANGE_EVENT,
        syncShortcutPreference,
      );
    };
  });

  function updateShortcutPreference(event: Event) {
    singleKeyShortcutsEnabled = (event.currentTarget as HTMLInputElement)
      .checked;
    setSingleKeyShortcutsEnabled(singleKeyShortcutsEnabled);
  }

  $effect(() => {
    if (!open) return;

    previouslyFocused = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => dialogEl?.focus());

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        open = false;
        return;
      }

      if (event.key !== 'Tab' || !dialogEl) return;

      const focusableElements = Array.from(
        dialogEl.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);

      if (focusableElements.length === 0) {
        event.preventDefault();
        dialogEl.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (!dialogEl.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (
        event.shiftKey &&
        (activeElement === first || activeElement === dialogEl)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (activeElement === last || activeElement === dialogEl)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeydown);

    return () => {
      document.removeEventListener('keydown', handleKeydown);
      previouslyFocused?.focus?.();
      previouslyFocused = null;
    };
  });
</script>

{#if open}
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-md"
    transition:fade={{ duration: 200 }}
    onclick={(event) => {
      if (event.target === event.currentTarget) open = false;
    }}
    role="presentation"
  >
    <div
      bind:this={dialogEl}
      class="glass-card max-h-[90dvh] w-full max-w-sm overflow-y-auto p-6 shadow-2xl"
      transition:fly={{ y: 20, duration: 300 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="keyboard-shortcuts-title"
      tabindex="-1"
    >
      <div class="mb-6 flex items-center justify-between">
        <h3 id="keyboard-shortcuts-title" class="text-lg font-bold">
          Keyboard Shortcuts
        </h3>
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

      <label
        class="mb-5 flex cursor-pointer items-start gap-3 border-b border-white/10 pb-5"
      >
        <input
          type="checkbox"
          class="mt-1 h-4 w-4 accent-primary-400"
          checked={singleKeyShortcutsEnabled}
          onchange={updateShortcutPreference}
        />
        <span class="space-y-1">
          <span class="block text-sm font-semibold"
            >Enable single-character shortcuts</span
          >
          <span class="block text-xs leading-relaxed text-surface-300">
            Turn this off to disable ? help and the J, K, O, H, S, and M article
            keys.
          </span>
        </span>
      </label>

      <div class="space-y-4">
        {#each shortcuts as shortcut (shortcut.key)}
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
      <p class="mt-5 text-xs text-surface-300">
        Press <kbd
          class="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-primary-300"
          >?</kbd
        > outside a text field to open this list while single-key shortcuts are enabled.
      </p>
    </div>
  </div>
{/if}

<style>
  kbd {
    box-shadow: 0 2px 0 0 rgba(0, 0, 0, 0.2);
  }
</style>
