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

  type ShortcutSection = {
    title: string;
    items: Array<{ key: string; description: string }>;
  };

  const globalSection: ShortcutSection = {
    title: 'Global & Navigation',
    items: [
      { key: '?', description: 'Show keyboard shortcuts' },
      { key: '/', description: 'Search library' },
      { key: '+', description: 'Add new feed' },
      { key: 'R', description: 'Sync feeds now' },
      { key: 'g a', description: 'Go to All' },
      { key: 'g u', description: 'Go to Unread' },
      { key: 'g b', description: 'Go to Saved' },
      { key: 'g d', description: 'Go to Briefing' },
      { key: 'g f', description: 'Go to Feeds' },
      { key: 'g s', description: 'Go to Settings' },
    ],
  };

  const listSection: ShortcutSection = {
    title: 'Article List',
    items: [
      { key: 'j', description: 'Focus next article' },
      { key: 'k', description: 'Focus previous article' },
      { key: 'o', description: 'Open focused article' },
      { key: 'v', description: 'Open original link in new tab' },
      { key: 'h', description: 'Hide focused article' },
      { key: 's', description: 'Save focused article' },
      { key: 'm', description: 'Toggle read / unread for focused article' },
      { key: 'l', description: 'Like or boost focused article' },
      { key: 'x', description: 'Dislike and hide focused article' },
      { key: 'Enter', description: 'Open article (when focused)' },
      { key: 'Space', description: 'Open article (when focused)' },
    ],
  };

  const readerSection: ShortcutSection = {
    title: 'Article Reader',
    items: [
      { key: 'j', description: 'Go to next article' },
      { key: 'k', description: 'Go to previous article' },
      { key: 'u', description: 'Return to article list' },
      { key: 'Esc', description: 'Close overlay or return to list' },
      { key: 'o', description: 'Open original article' },
      { key: 'v', description: 'Open publisher page in new tab' },
      { key: 'd', description: 'Fetch full article text' },
      { key: 'h', description: 'Hide or restore this article' },
      { key: 's', description: 'Toggle saved for this article' },
      { key: 'm', description: 'Toggle read / unread for this article' },
      { key: 'l', description: 'Like this article' },
      { key: 'x', description: 'Dislike and hide this article' },
    ],
  };

  const shortcutSections = $derived(
    reader
      ? [readerSection, globalSection, listSection]
      : [globalSection, listSection, readerSection],
  );

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
      class="glass-card flex max-h-[90dvh] w-full max-w-md flex-col overflow-y-auto p-6 shadow-2xl"
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
            Turn this off to disable single-key and g-chord navigation, search,
            sync, and article triage shortcuts.
          </span>
        </span>
      </label>

      <div class="min-h-0 flex-1 space-y-6 overflow-y-auto pr-1">
        {#each shortcutSections as section (section.title)}
          <section class="space-y-2.5">
            <h4
              class="text-xs font-bold uppercase tracking-wider text-surface-300"
            >
              {section.title}
            </h4>
            <div class="space-y-2.5">
              {#each section.items as shortcut (`${section.title}:${shortcut.key}`)}
                <div class="flex items-center justify-between gap-3">
                  <span class="text-sm text-surface-300"
                    >{shortcut.description}</span
                  >
                  <kbd
                    class="shrink-0 rounded border border-white/10 bg-white/5 px-2 py-1 text-xs font-mono text-primary-400"
                  >
                    {shortcut.key}
                  </kbd>
                </div>
              {/each}
            </div>
          </section>
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
