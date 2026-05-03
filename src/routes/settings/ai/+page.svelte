<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import type { AiProvider, AiModel } from '$lib/server/ai/types';

  let { data: pageData } = $props();

  let providers = $state<AiProvider[]>([]);
  let searchQuery = $state('');
  let selectedProviderId = $state('');
  let selectedModelId = $state('');
  let envConfig = $state<Record<string, string>>({});
  let customBaseUrl = $state('');
  let loading = $state(true);
  let message = $state('');
  let saving = $state(false);

  // Derived state
  const allModels = $derived(
    providers.flatMap(p => p.models.map(m => ({ ...m, provider: p })))
  );

  const filteredModels = $derived(
    searchQuery.length < 2 
      ? [] 
      : allModels.filter(m => 
          m.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
          m.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
          m.provider.name.toLowerCase().includes(searchQuery.toLowerCase())
        ).slice(0, 10)
  );

  const selectedProvider = $derived(providers.find(p => p.id === selectedProviderId));
  const selectedModel = $derived(selectedProvider?.models.find(m => m.id === selectedModelId));

  async function loadProviders() {
    try {
      const res = await fetch('/api/ai/providers');
      if (res.ok) {
        const data = await res.json();
        providers = data.providers;

        // Pre-fill from saved config
        if (pageData.configs && pageData.configs.length > 0) {
          const cfg = pageData.configs[0];
          selectedProviderId = cfg.provider_id;
          selectedModelId = cfg.model_id;
          envConfig = cfg.config || {};
          customBaseUrl = cfg.custom_base_url || '';
        }
      }
    } catch {
      message = 'Failed to load model registry.';
    } finally {
      loading = false;
    }
  }

  function selectModel(model: any) {
    selectedProviderId = model.provider.id;
    selectedModelId = model.id;
    searchQuery = '';

    // Initialize env vars if not present
    model.provider.requiredEnvVars.forEach((ev: string) => {
      if (!envConfig[ev]) envConfig[ev] = '';
    });
  }

  async function saveConfig() {
    message = '';
    saving = true;
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          providerId: selectedProviderId, 
          modelId: selectedModelId, 
          config: envConfig,
          customBaseUrl 
        })
      });
      if (res.ok) {
        message = 'Configuration saved successfully.';
      } else {
        const err = await res.json();
        message = `Error: ${err.error || 'Failed to save settings.'}`;
      }
    } catch {
      message = 'Connection error.';
    } finally {
      saving = false;
    }
  }

  $effect(() => { loadProviders(); });
</script>

<h2 class="section-title text-lg font-bold">AI & Model Registry</h2>
<p class="section-subtitle mb-6">Powered by <a href="https://models.dev" target="_blank" class="text-primary-500 hover:underline">models.dev</a>. Search for any model to get started.</p>

{#if loading}
  <div class="glass-card mt-4 h-64 animate-pulse p-5"></div>
{:else}
  <div class="space-y-6">
    <!-- Search Section -->
    <div class="glass-card relative z-20 p-5 md:p-6" in:fly={{ y: 14, duration: 320 }}>
      <label class="label">
        <span class="mb-2 block text-sm font-medium" style="color: var(--color-surface-100);">Search Models</span>
        <div class="relative">
          <input 
            class="input glass-input w-full pl-10" 
            type="search" 
            placeholder="e.g. gpt-4o, claude-3.5, llama-3..." 
            bind:value={searchQuery}
          />
          <div class="absolute left-3 top-1/2 -translate-y-1/2 opacity-50">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          </div>
        </div>
      </label>

      {#if filteredModels.length > 0}
        <div class="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-white/10 bg-surface-900 shadow-xl" in:fade={{ duration: 150 }}>
          {#each filteredModels as m}
            <button 
              class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5"
              onclick={() => selectModel(m)}
            >
              <img src="https://models.dev/logos/{m.provider.id}.svg" alt="" class="h-6 w-6 rounded-sm bg-white/10 p-1" onerror={(e) => ((e.currentTarget as HTMLImageElement).src = 'https://models.dev/logos/default.svg')} />
              <div class="flex-1">
                <div class="text-sm font-semibold text-white">{m.name}</div>
                <div class="text-xs opacity-60">{m.provider.name} • {m.id}</div>
              </div>
              <div class="text-right">
                <div class="text-[10px] font-mono opacity-40">{Math.round(m.contextWindow/1000)}k ctx</div>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    {#if selectedModel}
      <div class="glass-card space-y-6 p-5 md:p-6" in:fly={{ y: 20, duration: 400 }}>
        <!-- Selected Model Header -->
        <div class="flex items-start gap-4 border-b border-white/5 pb-6">
          <div class="flex h-16 w-16 items-center justify-center rounded-lg bg-white/5 p-3">
            <img src="https://models.dev/logos/{selectedProviderId}.svg" alt={selectedProvider?.name} class="max-h-full max-w-full" onerror={(e) => ((e.currentTarget as HTMLImageElement).src = 'https://models.dev/logos/default.svg')} />
          </div>
          <div class="flex-1">
            <h3 class="text-xl font-bold text-white">{selectedModel.name}</h3>
            <p class="text-sm opacity-70">{selectedProvider?.name} — {selectedModel.id}</p>

            <div class="mt-3 flex flex-wrap gap-2">
              <span class="badge variant-soft-surface text-[10px]">{selectedModel.contextWindow.toLocaleString()} tokens</span>
              {#if selectedModel.reasoning}<span class="badge variant-soft-primary text-[10px]">Reasoning</span>{/if}
              {#if selectedModel.toolCall}<span class="badge variant-soft-secondary text-[10px]">Tools</span>{/if}
              <span class="badge variant-soft-tertiary text-[10px]">${selectedModel.inputPrice}/1M in</span>
            </div>
          </div>
          <button class="btn-icon variant-soft-surface btn-sm" onclick={() => { selectedProviderId = ''; selectedModelId = ''; }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>

        <!-- Connection Settings -->
        <div class="space-y-4">
          <h4 class="text-sm font-bold uppercase tracking-wider opacity-50">Connection Credentials</h4>

          {#if selectedProvider?.requiredEnvVars.length === 0}
            <p class="text-sm italic opacity-60">This provider does not require any environment variables.</p>
          {:else}
            <div class="grid gap-4 sm:grid-cols-1">
              {#each selectedProvider?.requiredEnvVars || [] as ev}
                <label class="label">
                  <span class="mb-1 block text-xs font-medium opacity-80">{ev}</span>
                  <input 
                    class="input glass-input w-full" 
                    type="password" 
                    bind:value={envConfig[ev]} 
                    placeholder="Enter value..."
                  />
                </label>
              {/each}
            </div>
          {/if}

          <div class="pt-2">
            <label class="label">
              <span class="mb-1 block text-xs font-medium opacity-80">Custom Base URL (optional)</span>
              <input 
                class="input glass-input w-full" 
                type="url" 
                bind:value={customBaseUrl} 
                placeholder={selectedProvider?.baseUrl} 
              />
            </label>
          </div>
        </div>

        {#if message}
          <div class="flex items-center gap-2 rounded-sm border border-white/10 bg-white/5 px-4 py-3 text-sm" in:fly={{ y: 6, duration: 220 }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            {message}
          </div>
        {/if}

        <div class="flex items-center justify-between pt-4">
          <button 
            class="btn preset-filled-primary-500 flex items-center gap-2" 
            onclick={saveConfig}
            disabled={saving}
          >
            {#if saving}
              <div class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
            {:else}
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            {/if}
            Save Configuration
          </button>

          {#if selectedProvider?.docsUrl}
            <a href={selectedProvider.docsUrl} target="_blank" class="text-xs opacity-50 hover:opacity-100 flex items-center gap-1">
              View Documentation
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>
          {/if}
        </div>
      </div>
    {:else}
      <div class="glass-card relative z-10 flex flex-col items-center justify-center p-12 text-center" in:fade>
        <div class="mb-4 rounded-full bg-white/5 p-4 opacity-30">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>
        </div>
        <p class="max-w-xs text-sm opacity-50">Select a model above to configure your AI provider. Article ranking and summarization will use the selected model.</p>
      </div>
    {/if}
  </div>
{/if}

<style>
  .glass-input {
    background: rgba(255, 255, 255, 0.03);
    border-color: rgba(255, 255, 255, 0.1);
  }
  .glass-input:focus {
    background: rgba(255, 255, 255, 0.05);
    border-color: var(--color-primary-500);
    box-shadow: 0 0 0 2px rgba(var(--color-primary-500) / 0.1);
  }
</style>