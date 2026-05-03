<script lang="ts">
  let { data: pageData } = $props();
  let providers = $state<any[]>([]);
  let selectedProvider = $state('');
  let selectedModel = $state('');
  let apiKey = $state('');
  let customBaseUrl = $state('');
  let loading = $state(true);
  let message = $state('');

  async function loadProviders() {
    try {
      const res = await fetch('/api/ai/providers');
      if (res.ok) {
        const data = await res.json();
        providers = data.providers;
      }
    } catch {} finally { loading = false; }
  }

  async function saveConfig() {
    message = '';
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'ai_enabled', value: selectedProvider ? 'true' : 'false' })
      });
      if (res.ok) message = 'Settings saved. AI features will be configured in a future update.';
      else message = 'Failed to save settings.';
    } catch { message = 'Connection error.'; }
  }

  $effect(() => { loadProviders(); });
</script>

<h2 class="section-title text-lg">AI Provider</h2>
<p class="section-subtitle">Configure an AI provider for article scoring and summarization.</p>

{#if loading}
  <div class="glass-card mt-8 h-32 animate-pulse p-5"></div>
{:else if providers.length === 0}
  <div class="glass-card mt-8 p-5">
    <p class="text-sm" style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);">No provider metadata available.</p>
  </div>
{:else}
  <div class="glass-card glass-card-hover mt-8 space-y-5 p-5 md:p-6">
    <label class="label">
      <span class="mb-1 block text-sm font-medium" style="color: var(--color-surface-100);">Provider</span>
      <select class="input glass-input" bind:value={selectedProvider} onchange={() => { selectedModel = ''; }}>
        <option value="">-- Select Provider --</option>
        {#each providers as p}
          <option value={p.id}>{p.name} — {p.description}</option>
        {/each}
      </select>
    </label>

    {#if selectedProvider}
      {@const provider = providers.find((p: any) => p.id === selectedProvider)}
      <label class="label">
        <span class="mb-1 block text-sm font-medium" style="color: var(--color-surface-100);">Model</span>
        <select class="input glass-input" bind:value={selectedModel}>
          <option value="">-- Select Model --</option>
          {#each provider.models as m}
            <option value={m.id}>{m.name} ({m.contextWindow.toLocaleString()} ctx)</option>
          {/each}
        </select>
      </label>

      <label class="label">
        <span class="mb-1 block text-sm font-medium" style="color: var(--color-surface-100);">API Key</span>
        <input class="input glass-input" type="password" bind:value={apiKey} placeholder="sk-..." />
      </label>

      <label class="label">
        <span class="mb-1 block text-sm font-medium" style="color: var(--color-surface-100);">Custom Base URL (optional)</span>
        <input class="input glass-input" type="url" bind:value={customBaseUrl} placeholder={provider.baseUrl} />
      </label>
    {/if}

    {#if message}
      <div class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm" style="background: color-mix(in oklch, var(--color-surface-100) 6%, transparent); color: color-mix(in oklch, var(--color-surface-100) 75%, transparent); border: 1px solid color-mix(in oklch, var(--color-surface-100) 10%, transparent);">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        {message}
      </div>
    {/if}

    <button class="btn preset-filled-primary-500 inline-flex items-center gap-2" onclick={saveConfig}>
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
      Save Configuration
    </button>

    <div class="border-t pt-4" style="border-color: color-mix(in oklch, var(--color-surface-100) 6%, transparent);">
      <p class="text-xs" style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);">
        <strong style="color: var(--color-surface-100);">Not using AI?</strong> The app works without AI. Articles are ranked using heuristic scoring based on recency and your interactions.
      </p>
    </div>
  </div>
{/if}