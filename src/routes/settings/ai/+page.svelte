<script lang="ts">
  import { tick } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import type { AiProvider, AiModel } from '$lib/server/ai/types';
  import { fetchWithCsrf } from '$lib/client/csrf';

  let providers = $state<AiProvider[]>([]);
  let searchQuery = $state('');
  let selectedProviderId = $state('');
  let selectedModelId = $state('');
  let activeModelIndex = $state(-1);
  let modelSuggestionsDismissed = $state(false);
  let envConfig = $state<Record<string, string>>({});
  let customBaseUrl = $state('');
  let hasSavedConfig = $state(false);
  let savedProviderId = $state('');
  let hasSavedCredential = $state(false);
  let loading = $state(true);
  let message = $state('');
  let messageIsError = $state(false);
  let registryError = $state('');
  let saving = $state(false);
  let aiEnabled = $state(true);
  let aiConfigured = $state(false);
  let savingAiEnabled = $state(false);
  let aiStatusMessage = $state('');
  let analysisCounts = $state({
    pending: 0,
    ready: 0,
    failed: 0,
    skipped: 0,
  });
  let aiJobCounts = $state({ queued: 0, processing: 0 });
  let recentFailures = $state<
    Array<{
      article_id: string;
      title: string;
      feed_title: string;
      analysis_status: 'failed' | 'skipped';
      analysis_error: string;
      processed_at: number | null;
    }>
  >([]);

  // Derived state
  const allModels = $derived(
    providers.flatMap((p) => p.models.map((m) => ({ ...m, provider: p }))),
  );

  const filteredModels = $derived(
    searchQuery.length < 2
      ? []
      : allModels
          .filter(
            (m) =>
              m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
              m.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
              m.provider.name.toLowerCase().includes(searchQuery.toLowerCase()),
          )
          .slice(0, 10),
  );
  const showModelOptions = $derived(
    !modelSuggestionsDismissed && filteredModels.length > 0,
  );

  function applyConfigData(data: Record<string, any>) {
    aiEnabled = data.aiEnabled !== false;
    aiConfigured = Boolean(data.aiConfigured);
    analysisCounts = data.analysisCounts || analysisCounts;
    aiJobCounts = data.aiJobCounts || aiJobCounts;
    recentFailures = Array.isArray(data.recentFailures)
      ? data.recentFailures
      : [];

    const configs = Array.isArray(data.configs) ? data.configs : [];
    const cfg =
      configs.find((item: { enabled?: number }) => item.enabled) ?? configs[0];
    hasSavedConfig = Boolean(cfg);
    savedProviderId = cfg?.provider_id ?? '';
    hasSavedCredential = Boolean(cfg?.has_api_key);
    selectedProviderId = cfg?.provider_id ?? '';
    selectedModelId = cfg?.model_id ?? '';
    customBaseUrl = cfg?.custom_base_url ?? '';
    envConfig = {};
  }

  async function refreshAiSettings() {
    const response = await fetch('/api/ai/config');
    if (!response.ok) throw new Error('Could not refresh AI settings.');
    applyConfigData(await response.json());
  }

  const selectedProvider = $derived(
    providers.find((p) => p.id === selectedProviderId),
  );
  const selectedModel = $derived(
    selectedProvider?.models.find((m) => m.id === selectedModelId),
  );

  async function loadProviders() {
    loading = true;
    registryError = '';
    message = '';
    messageIsError = false;
    try {
      const [providerResult, configResult] = await Promise.allSettled([
        fetch('/api/ai/providers'),
        fetch('/api/ai/config'),
      ]);

      if (providerResult.status === 'fulfilled' && providerResult.value.ok) {
        try {
          const data = await providerResult.value.json();
          providers = Array.isArray(data.providers) ? data.providers : [];
          if (providers.length === 0) {
            registryError = 'The model registry returned no providers.';
          }
        } catch {
          registryError = 'Could not load the model registry. Try again.';
        }
      } else {
        registryError = 'Could not load the model registry. Try again.';
      }

      if (configResult.status === 'fulfilled' && configResult.value.ok) {
        applyConfigData(await configResult.value.json());
      } else {
        message = 'Could not load AI settings.';
        messageIsError = true;
      }

      if (hasSavedCredential && !messageIsError) {
        message =
          'Credentials are stored securely. Leave blank to keep them unchanged.';
      }
    } catch {
      message = 'Failed to load AI settings.';
      messageIsError = true;
    } finally {
      loading = false;
    }
  }

  function handleModelSearchKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' && filteredModels.length > 0) {
      event.preventDefault();
      modelSuggestionsDismissed = false;
      setActiveModelIndex((activeModelIndex + 1) % filteredModels.length);
    } else if (event.key === 'ArrowUp' && filteredModels.length > 0) {
      event.preventDefault();
      modelSuggestionsDismissed = false;
      setActiveModelIndex(
        activeModelIndex <= 0
          ? filteredModels.length - 1
          : activeModelIndex - 1,
      );
    } else if (
      event.key === 'Enter' &&
      showModelOptions &&
      activeModelIndex >= 0
    ) {
      event.preventDefault();
      selectModel(filteredModels[activeModelIndex]);
    } else if (event.key === 'Escape' && showModelOptions) {
      event.preventDefault();
      modelSuggestionsDismissed = true;
      activeModelIndex = -1;
    }
  }

  function setActiveModelIndex(index: number) {
    activeModelIndex = index;
    void tick().then(() =>
      document
        .getElementById(`ai-model-option-${index}`)
        ?.scrollIntoView({ block: 'nearest' }),
    );
  }

  async function setAiEnabled(event: Event) {
    const nextEnabled = (event.currentTarget as HTMLInputElement).checked;
    const previousEnabled = aiEnabled;
    savingAiEnabled = true;
    aiStatusMessage = '';
    try {
      const response = await fetchWithCsrf('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      if (!response.ok) throw new Error('Failed to update AI processing.');
      aiEnabled = nextEnabled;
      aiStatusMessage = nextEnabled
        ? 'Background AI processing is enabled.'
        : 'Background AI processing is paused.';
    } catch {
      aiEnabled = previousEnabled;
      aiStatusMessage = 'Could not update AI processing.';
    } finally {
      savingAiEnabled = false;
    }
  }

  function selectModel(model: AiModel & { provider: AiProvider }) {
    if (selectedProviderId !== model.provider.id) {
      envConfig = {};
      hasSavedCredential =
        savedProviderId === model.provider.id && hasSavedCredential;
    }
    selectedProviderId = model.provider.id;
    selectedModelId = model.id;
    searchQuery = '';
    activeModelIndex = -1;
    modelSuggestionsDismissed = false;

    // Initialize env vars if not present
    model.provider.requiredEnvVars.forEach((ev: string) => {
      if (!envConfig[ev]) envConfig[ev] = '';
    });
  }

  async function saveConfig() {
    message = '';
    messageIsError = false;
    saving = true;
    try {
      const res = await fetchWithCsrf('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: selectedProviderId,
          modelId: selectedModelId,
          config: Object.fromEntries(
            Object.entries(envConfig).filter(
              ([, value]) => value.trim().length > 0,
            ),
          ),
          customBaseUrl,
        }),
      });
      if (res.ok) {
        await refreshAiSettings();
        message =
          'Configuration saved. Background processing keeps its current state.';
        messageIsError = false;
      } else {
        const err = await res.json();
        message = `Error: ${err.error || 'Failed to save settings.'}`;
        messageIsError = true;
      }
    } catch {
      message = 'Could not save or refresh AI settings. Try again.';
      messageIsError = true;
    } finally {
      saving = false;
    }
  }

  async function clearSelectedModel() {
    if (!hasSavedConfig) {
      selectedProviderId = '';
      selectedModelId = '';
      customBaseUrl = '';
      envConfig = {};
      hasSavedCredential = false;
      return;
    }

    saving = true;
    message = '';
    messageIsError = false;
    try {
      const response = await fetchWithCsrf('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      });
      if (!response.ok) throw new Error('Could not clear the saved model.');
      await refreshAiSettings();
      message = 'Saved model configuration cleared.';
    } catch {
      message = 'Could not clear the saved model configuration.';
      messageIsError = true;
    } finally {
      saving = false;
    }
  }

  $effect(() => {
    loadProviders();
  });
</script>

<svelte:head>
  <title>AI Settings · Feed Me Maybe</title>
</svelte:head>

<h2 class="section-title text-lg font-bold">AI & Model Registry</h2>
<p class="section-subtitle mb-6">
  Powered by <a
    href="https://models.dev"
    target="_blank"
    class="text-primary-500 underline underline-offset-2">models.dev</a
  >. Search for any model to get started.
</p>

{#if registryError}
  <div
    class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-sm border border-error-500/20 bg-error-500/10 px-4 py-3 text-sm text-error-300"
    role="alert"
  >
    <span>{registryError}</span>
    <button
      type="button"
      class="btn preset-tonal-error btn-sm"
      onclick={() => void loadProviders()}
      disabled={loading}>Retry</button
    >
  </div>
{/if}

{#if loading}
  <div
    class="glass-card mt-4 h-64 animate-pulse p-5"
    aria-busy="true"
    aria-label="Loading AI settings"
  ></div>
{:else}
  <div class="space-y-6">
    <section
      class="glass-card space-y-5 p-5 md:p-6"
      aria-labelledby="ai-processing-heading"
    >
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 id="ai-processing-heading" class="text-base font-bold text-white">
            Background AI processing
          </h3>
          <p class="mt-1 max-w-2xl text-sm opacity-70">
            Pause or resume article enrichment. Existing article data stays
            available while processing is paused. Personalized ranking uses the
            separate Jev or SubQ provider and local heuristic scores.
          </p>
        </div>
        <label class="flex cursor-pointer items-center gap-3 text-sm">
          <input
            type="checkbox"
            class="h-4 w-4 accent-primary-500"
            checked={aiEnabled}
            onchange={setAiEnabled}
            disabled={savingAiEnabled}
            aria-label="Enable background AI processing"
          />
          <span>{aiEnabled ? 'Enabled' : 'Paused'}</span>
        </label>
      </div>

      {#if !aiConfigured}
        <p
          class="rounded-sm border border-white/10 bg-white/5 px-3 py-2 text-sm opacity-75"
        >
          No AI provider is configured. Select a compatible model below to start
          enrichment.
        </p>
      {/if}
      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {aiStatusMessage}
      </p>

      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {#each [{ label: 'Ready', value: analysisCounts.ready }, { label: 'Failed', value: analysisCounts.failed }, { label: 'Skipped', value: analysisCounts.skipped }, { label: 'Pending metadata', value: analysisCounts.pending }, { label: 'Queued jobs', value: aiJobCounts.queued }, { label: 'Running jobs', value: aiJobCounts.processing }] as item (item.label)}
          <div class="rounded-sm border border-white/10 bg-white/5 px-3 py-3">
            <div class="text-xl font-semibold text-white">{item.value}</div>
            <div class="mt-1 text-xs opacity-65">{item.label}</div>
          </div>
        {/each}
      </div>

      <div>
        <h4 class="text-sm font-bold text-white">Recent enrichment failures</h4>
        {#if recentFailures.length === 0}
          <p class="mt-2 text-sm opacity-65">
            No failed or skipped analyses with recorded errors.
          </p>
        {:else}
          <ul class="mt-3 divide-y divide-white/10">
            {#each recentFailures as failure (failure.article_id)}
              <li class="py-3">
                <div
                  class="flex flex-wrap items-baseline justify-between gap-2"
                >
                  <span class="text-sm font-medium text-white"
                    >{failure.title}</span
                  >
                  <span class="text-xs uppercase tracking-wide opacity-60">
                    {failure.analysis_status} · {failure.feed_title}
                  </span>
                </div>
                <p class="mt-1 break-words text-sm opacity-70">
                  {failure.analysis_error}
                </p>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </section>

    <!-- Search Section -->
    <div
      class="glass-card relative z-20 p-5 md:p-6"
      in:fly={{ y: 14, duration: 320 }}
    >
      <label class="label">
        <span
          class="mb-2 block text-sm font-medium"
          style="color: var(--color-surface-100);">Search Models</span
        >
        <div class="relative">
          <input
            class="input glass-input w-full pl-10"
            type="search"
            placeholder="e.g. gpt-4o, claude-3.5, llama-3..."
            value={searchQuery}
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={showModelOptions}
            aria-controls="ai-model-options"
            aria-activedescendant={showModelOptions && activeModelIndex >= 0
              ? `ai-model-option-${activeModelIndex}`
              : undefined}
            oninput={(event) => {
              searchQuery = (event.currentTarget as HTMLInputElement).value;
              activeModelIndex = -1;
              modelSuggestionsDismissed = false;
            }}
            onkeydown={handleModelSearchKeydown}
          />
          <div class="absolute left-3 top-1/2 -translate-y-1/2 opacity-50">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg
            >
          </div>
        </div>
      </label>

      <div
        id="ai-model-options"
        class="absolute left-0 right-0 top-full z-50 mt-1 max-h-[min(60vh,28rem)] overflow-y-auto rounded-md border border-white/10 bg-surface-900 shadow-xl"
        role="listbox"
        aria-label="Model suggestions"
        hidden={!showModelOptions}
        in:fade={{ duration: 150 }}
      >
        {#each filteredModels as m, index}
          <button
            id="ai-model-option-{index}"
            type="button"
            role="option"
            aria-selected={activeModelIndex === index}
            tabindex="-1"
            class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5 {activeModelIndex ===
            index
              ? 'bg-white/10'
              : ''}"
            onmousedown={(event) => event.preventDefault()}
            onclick={() => selectModel(m)}
          >
            <img
              src="https://models.dev/logos/{m.provider.id}.svg"
              alt=""
              class="h-6 w-6 rounded-sm bg-white/10 p-1"
              onerror={(e) =>
                ((e.currentTarget as HTMLImageElement).src =
                  'https://models.dev/logos/default.svg')}
            />
            <div class="flex-1">
              <div class="text-sm font-semibold text-white">{m.name}</div>
              <div class="text-xs opacity-60">{m.provider.name} • {m.id}</div>
            </div>
            <div class="text-right">
              <div class="text-[10px] font-mono opacity-40">
                {Math.round(m.contextWindow / 1000)}k ctx
              </div>
            </div>
          </button>
        {/each}
      </div>
      {#if searchQuery.length >= 2 && filteredModels.length === 0 && !registryError}
        <p class="mt-2 text-sm opacity-65" role="status">
          No matching models found.
        </p>
      {/if}
    </div>

    {#if message}
      <div
        class="flex items-center gap-2 rounded-sm border border-white/10 bg-white/5 px-4 py-3 text-sm"
        role={messageIsError ? 'alert' : 'status'}
        aria-live={messageIsError ? 'assertive' : 'polite'}
        aria-atomic="true"
        in:fly={{ y: 6, duration: 220 }}
      >
        {message}
      </div>
    {/if}

    {#if selectedModel}
      <div
        class="glass-card space-y-6 p-5 md:p-6"
        in:fly={{ y: 20, duration: 400 }}
      >
        <!-- Selected Model Header -->
        <div class="flex items-start gap-4 border-b border-white/5 pb-6">
          <div
            class="flex h-16 w-16 items-center justify-center rounded-lg bg-white/5 p-3"
          >
            <img
              src="https://models.dev/logos/{selectedProviderId}.svg"
              alt={selectedProvider?.name}
              class="max-h-full max-w-full"
              onerror={(e) =>
                ((e.currentTarget as HTMLImageElement).src =
                  'https://models.dev/logos/default.svg')}
            />
          </div>
          <div class="flex-1">
            <h3 class="text-xl font-bold text-white">{selectedModel.name}</h3>
            <p class="text-sm opacity-70">
              {selectedProvider?.name} — {selectedModel.id}
            </p>

            <div class="mt-3 flex flex-wrap gap-2">
              <span class="badge variant-soft-surface text-[10px]"
                >{selectedModel.contextWindow.toLocaleString()} tokens</span
              >
              {#if selectedModel.reasoning}<span
                  class="badge variant-soft-primary text-[10px]">Reasoning</span
                >{/if}
              {#if selectedModel.toolCall}<span
                  class="badge variant-soft-secondary text-[10px]">Tools</span
                >{/if}
              <span class="badge variant-soft-tertiary text-[10px]"
                >${selectedModel.inputPrice}/1M in</span
              >
            </div>
          </div>
          <button
            class="btn-icon variant-soft-surface btn-sm"
            aria-label="Clear saved model configuration"
            title="Clear saved model configuration"
            onclick={clearSelectedModel}
            disabled={saving}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              ><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg
            >
          </button>
        </div>

        <!-- Connection Settings -->
        <div class="space-y-4">
          <h4 class="text-sm font-bold uppercase tracking-wider opacity-50">
            Connection Credentials
          </h4>

          {#if selectedProvider?.requiredEnvVars.length === 0}
            <label class="label">
              <span class="mb-1 block text-xs font-medium opacity-80"
                >API key</span
              >
              <input
                class="input glass-input w-full"
                type="password"
                bind:value={envConfig.apiKey}
                autocomplete="new-password"
                placeholder={hasSavedCredential
                  ? 'Stored securely — leave blank to keep'
                  : 'Enter provider API key'}
                aria-describedby="ai-credential-help"
              />
            </label>
            <p id="ai-credential-help" class="text-xs opacity-60">
              Credentials are encrypted on this server. Saving with a blank
              field keeps an existing credential; a new configuration needs a
              key.
            </p>
          {:else}
            <div class="grid gap-4 sm:grid-cols-1">
              {#each selectedProvider?.requiredEnvVars || [] as ev}
                <label class="label">
                  <span class="mb-1 block text-xs font-medium opacity-80"
                    >{ev}</span
                  >
                  <input
                    class="input glass-input w-full"
                    type="password"
                    bind:value={envConfig[ev]}
                    autocomplete="new-password"
                    placeholder={hasSavedCredential
                      ? 'Stored securely — leave blank to keep'
                      : 'Enter value...'}
                  />
                </label>
              {/each}
            </div>
          {/if}

          <div class="pt-2">
            <label class="label">
              <span class="mb-1 block text-xs font-medium opacity-80"
                >Custom Base URL (optional)</span
              >
              <input
                class="input glass-input w-full"
                type="url"
                bind:value={customBaseUrl}
                placeholder={selectedProvider?.baseUrl}
              />
            </label>
          </div>
        </div>

        <div class="flex items-center justify-between pt-4">
          <button
            class="btn preset-filled-primary-500 flex items-center gap-2"
            onclick={saveConfig}
            disabled={saving}
          >
            {#if saving}
              <div
                class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
              ></div>
            {:else}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                ><path
                  d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"
                /><polyline points="17 21 17 13 7 13 7 21" /><polyline
                  points="7 3 7 8 15 8"
                /></svg
              >
            {/if}
            Save Configuration
          </button>

          {#if selectedProvider?.docsUrl}
            <a
              href={selectedProvider.docsUrl}
              target="_blank"
              class="flex items-center gap-1 text-xs underline underline-offset-2"
            >
              View Documentation
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                ><path
                  d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
                /><polyline points="15 3 21 3 21 9" /><line
                  x1="10"
                  y1="14"
                  x2="21"
                  y2="3"
                /></svg
              >
            </a>
          {/if}
        </div>
      </div>
    {:else}
      <div
        class="glass-card relative z-10 flex flex-col items-center justify-center p-12 text-center"
        in:fade
      >
        <div class="mb-4 rounded-full bg-white/5 p-4 opacity-30">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            ><path d="M12 8V4H8" /><rect
              width="16"
              height="12"
              x="4"
              y="8"
              rx="2"
            /><path d="M2 14h2" /><path d="M20 14h2" /><path
              d="M15 13v2"
            /><path d="M9 13v2" /></svg
          >
        </div>
        <p class="max-w-xs text-sm opacity-50">
          Select a model above for article enrichment, including summaries and
          metadata. Personalized feed ranking uses the separate Jev or SubQ
          provider together with local heuristic scores.
        </p>
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
