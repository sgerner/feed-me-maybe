<script lang="ts">
  let { data: pageData } = $props();
  let msg = $state('');

  async function deletePref(id: string) {
    await fetch(`/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `delete_pref_${id}`, value: 'true' })
    });
    window.location.reload();
  }

  async function resetTraining() {
    if (!confirm('Reset all training data? This will clear all interactions and preferences.')) return;
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'reset_training', value: 'true' })
    });
    msg = 'Training data reset requested.';
  }
</script>

<h2 class="section-title text-lg">Memory & Preferences</h2>
<p class="section-subtitle">Learned preferences based on your interactions.</p>

{#if msg}
  <div class="mt-5 flex items-center gap-2 rounded-lg px-3 py-2 text-sm" style="background: color-mix(in oklch, var(--color-success-500) 10%, transparent); color: var(--color-success-300); border: 1px solid color-mix(in oklch, var(--color-success-500) 20%, transparent);">
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
    {msg}
  </div>
{/if}

{#if pageData.preferences.length === 0}
  <div class="glass-card mt-8 p-8 text-center text-sm" style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);">
    <div class="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full" style="background: color-mix(in oklch, var(--color-tertiary-500) 10%, transparent);">
      <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--color-tertiary-400);">
        <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 12v.01"/><path d="M11 17v.01"/><path d="M7 14v.01"/></svg>
    </div>
    <p class="font-medium" style="color: var(--color-surface-100);">No preferences learned yet</p>
    <p class="mt-1">Interact with articles to build your profile.</p>
  </div>
{:else}
  <div class="mt-8 space-y-3">
    {#each pageData.preferences as p}
      <div class="glass-card glass-card-hover p-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider" style={p.polarity === 'positive' ? 'background: color-mix(in oklch, var(--color-success-500) 12%, transparent); color: var(--color-success-300);' : 'background: color-mix(in oklch, var(--color-warning-500) 12%, transparent); color: var(--color-warning-300);'}>
              {p.type}
            </span>
            <span class="text-sm font-medium" style="color: var(--color-surface-50);">{p.label}</span>
          </div>
          <button class="flex h-7 w-7 items-center justify-center rounded-md text-xs transition-colors hover:bg-surface-100/10" style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);" aria-label="Delete preference" onclick={() => deletePref(p.id)}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="mt-2 flex items-center gap-3 text-xs" style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);">
          <div class="h-2 w-28 overflow-hidden rounded-full" style="background: color-mix(in oklch, var(--color-surface-100) 8%, transparent);">
            <div class="h-2 rounded-full transition-all duration-500" style="width: {p.strength * 100}%; background: linear-gradient(90deg, var(--color-primary-500), var(--color-secondary-500)); box-shadow: 0 0 8px color-mix(in oklch, var(--color-primary-500) 40%, transparent);"></div>
          </div>
          <span>{(p.strength * 100).toFixed(0)}% · {p.evidence_count} evidence</span>
        </div>
      </div>
    {/each}
  </div>
{/if}

<button class="action-btn mt-6 px-4 py-2 text-error-300" style="border-color: color-mix(in oklch, var(--color-error-500) 15%, transparent);" onclick={resetTraining}>
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
  Reset All Training
</button>