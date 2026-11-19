<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { fetchWithCsrf } from '$lib/client/csrf';
  let { data: pageData } = $props();
  let msg = $state('');
  let pending = $state(false);
  let failed = $state(false);
  let preferences = $state<
    Array<{
      id: string;
      polarity: 'positive' | 'negative';
      type: string;
      label: string;
      strength: number;
      evidence_count: number;
    }>
  >([]);

  $effect(() => {
    preferences = (pageData?.preferences ?? []) as Array<{
      id: string;
      polarity: 'positive' | 'negative';
      type: string;
      label: string;
      strength: number;
      evidence_count: number;
    }>;
  });

  async function updateTraining(key: string, id?: string) {
    if (pending) return;
    pending = true;
    msg = '';
    failed = false;
    try {
      const response = await fetchWithCsrf('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: 'true' }),
      });
      if (!response.ok) throw new Error('Preference update failed');
      preferences = id
        ? preferences.filter((preference) => preference.id !== id)
        : [];
      msg = id ? 'Preference removed.' : 'Training data reset.';
    } catch {
      failed = true;
      msg = id
        ? 'Could not remove preference.'
        : 'Could not reset training data.';
    } finally {
      pending = false;
    }
  }

  function resetTraining() {
    if (
      confirm(
        'Reset learned preferences and ranking feedback? This clears interaction history used for learning, while reading status, saved articles, and article reactions stay.',
      )
    ) {
      void updateTraining('reset_training');
    }
  }
</script>

<svelte:head>
  <title>Memory &amp; Preferences · Feed Me Maybe</title>
</svelte:head>

<h2 class="section-title text-lg">Memory & Preferences</h2>
<p class="section-subtitle">Learned preferences based on your interactions.</p>

{#if msg}
  <div
    class="mt-5 flex items-center gap-2 px-3 py-2 text-sm"
    role={failed ? 'alert' : 'status'}
    style="background: color-mix(in oklch, var(--color-success-500) 10%, transparent); color: {failed
      ? 'var(--color-error-300)'
      : 'var(--color-success-300)'}; border: 1px solid color-mix(in oklch, var(--color-success-500) 20%, transparent); border-radius: 2px;"
    in:fly={{ y: 6, duration: 220 }}
  >
    {msg}
  </div>
{/if}

{#if preferences.length === 0}
  <div
    class="glass-card mt-8 p-8 text-center text-sm"
    style="color: var(--color-surface-300);"
    in:fade={{ duration: 300 }}
  >
    <div
      class="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full"
      style="background: color-mix(in oklch, var(--color-tertiary-500) 10%, transparent);"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        style="color: var(--color-tertiary-400);"
      >
        <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" /><path
          d="M8.5 8.5v.01"
        /><path d="M16 15.5v.01" /><path d="M12 12v.01" /><path
          d="M11 17v.01"
        /><path d="M7 14v.01" /></svg
      >
    </div>
    <p class="font-medium" style="color: var(--color-surface-100);">
      No preferences learned yet
    </p>
    <p class="mt-1">Interact with articles to build your profile.</p>
  </div>
{:else}
  <div class="mt-8 space-y-3">
    {#each preferences as p, i}
      <div
        class="glass-card glass-card-hover p-4"
        in:fly={{ y: 10, duration: 280, delay: Math.min(i * 30, 300) }}
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span
              class="inline-flex items-center px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
              style={p.polarity === 'positive'
                ? 'background: color-mix(in oklch, var(--color-success-500) 12%, transparent); color: var(--color-success-300); border-radius: 2px;'
                : 'background: color-mix(in oklch, var(--color-warning-500) 12%, transparent); color: var(--color-warning-300); border-radius: 2px;'}
            >
              {p.type}
            </span>
            <span
              class="text-sm font-medium"
              style="color: var(--color-surface-50);">{p.label}</span
            >
          </div>
          <button
            class="flex h-7 w-7 items-center justify-center text-xs transition-colors hover:bg-surface-100/10"
            style="color: var(--color-surface-300); border-radius: 2px;"
            aria-label="Delete preference"
            onclick={() => updateTraining(`delete_pref_${p.id}`, p.id)}
            disabled={pending}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              ><line x1="18" y1="6" x2="6" y2="18" /><line
                x1="6"
                y1="6"
                x2="18"
                y2="18"
              /></svg
            >
          </button>
        </div>
        <div
          class="mt-2 flex items-center gap-3 text-xs"
          style="color: var(--color-surface-300);"
        >
          <div
            class="h-2 w-28 overflow-hidden"
            style="background: color-mix(in oklch, var(--color-surface-100) 8%, transparent); border-radius: 2px;"
          >
            <div
              class="h-2 transition-all duration-500"
              style="width: {p.strength *
                100}%; background: linear-gradient(90deg, var(--color-primary-500), var(--color-secondary-500)); box-shadow: 0 0 8px color-mix(in oklch, var(--color-primary-500) 40%, transparent); border-radius: 2px;"
            ></div>
          </div>
          <span
            >{(p.strength * 100).toFixed(0)}% · {p.evidence_count} evidence</span
          >
        </div>
      </div>
    {/each}
  </div>
{/if}

<button
  class="action-btn mt-6 px-4 py-2 text-error-300"
  style="border-color: color-mix(in oklch, var(--color-error-500) 15%, transparent);"
  onclick={resetTraining}
  disabled={pending}
>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    ><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path
      d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"
    /></svg
  >
  Reset All Training
</button>
