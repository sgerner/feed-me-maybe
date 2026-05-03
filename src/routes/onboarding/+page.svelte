<script lang="ts">
  let step = $state(1);
  const totalSteps = 4;
  let feedUrl = $state('');
  let feedTitle = $state('');
  let skipAi = $state(false);
  let loading = $state(false);
  let error = $state('');

  function nextStep() {
    if (step < totalSteps) {
      step++;
    }
  }

  async function addFeed() {
    if (!feedUrl.trim()) return;
    loading = true;
    error = '';
    try {
      const res = await fetch('/api/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: feedUrl.trim(), title: feedTitle.trim() })
      });
      if (!res.ok) {
        const d = await res.json();
        error = d.error || 'Failed';
        return;
      }
      feedUrl = '';
      feedTitle = '';
      nextStep();
    } catch {
      error = 'Connection error';
    } finally {
      loading = false;
    }
  }

  function skipFeeds() {
    nextStep();
  }

  function handleAiChoice(skip: boolean) {
    skipAi = skip;
    nextStep();
  }

  async function finishSetup() {
    loading = true;
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'setup_complete', value: 'true' })
    });
    window.location.href = '/today';
  }
</script>

<div class="container mx-auto max-w-lg px-4 py-10">
  <!-- Step indicator -->
  <div class="mb-10 flex items-center justify-center gap-3">
    {#each [1,2,3,4] as s (s)}
      <div class="step-dot" class:step-dot-active={s <= step} class:step-dot-inactive={s > step}></div>
    {/each}
  </div>

  {#if step === 1}
    <div class="glass-card p-8 text-center">
      <div class="mb-6 inline-flex h-20 w-20 items-center justify-center rounded-full" style="background: color-mix(in oklch, var(--color-primary-500) 12%, transparent); box-shadow: 0 0 30px -5px color-mix(in oklch, var(--color-primary-500) 30%, transparent);">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-primary-400">
          <path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>
        </svg>
      </div>
      <h1 class="gradient-text text-2xl font-bold">Welcome to Feed Me Maybe</h1>
      <p class="mt-4" style="color: color-mix(in oklch, var(--color-surface-200) 60%, transparent);">
        Your AI-powered RSS reader that learns what you actually want to read.
      </p>
      <button class="btn preset-filled-primary-500 mt-8 inline-flex items-center gap-2" onclick={nextStep}>
        Get Started
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
      </button>
    </div>

  {:else if step === 2}
    <div class="glass-card p-6 md:p-8">
      <h2 class="text-xl font-bold" style="color: var(--color-surface-50);">Add Your First Feed</h2>
      <p class="mt-2 text-sm" style="color: color-mix(in oklch, var(--color-surface-200) 55%, transparent);">
        Enter an RSS or Atom feed URL to get started.
      </p>
      <div class="mt-5 space-y-3">
        <input
          type="url"
          bind:value={feedUrl}
          placeholder="https://example.com/feed.xml"
          class="input glass-input w-full"
        />
        <input
          type="text"
          bind:value={feedTitle}
          placeholder="Feed title (optional)"
          class="input glass-input w-full"
        />
        {#if error}
          <div class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm" style="background: color-mix(in oklch, var(--color-error-500) 10%, transparent); color: var(--color-error-300); border: 1px solid color-mix(in oklch, var(--color-error-500) 20%, transparent);">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            {error}
          </div>
        {/if}
      </div>
      <div class="mt-6 flex gap-3">
        <button class="action-btn px-4 py-2" onclick={skipFeeds} disabled={loading}>
          Skip
        </button>
        <button class="btn preset-filled-primary-500 inline-flex items-center gap-2" onclick={addFeed} disabled={loading || !feedUrl.trim()}>
          {#if loading}
            <svg class="animate-spin" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            Adding...
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Feed
          {/if}
        </button>
      </div>
    </div>

  {:else if step === 3}
    <div class="glass-card p-6 md:p-8">
      <h2 class="text-xl font-bold" style="color: var(--color-surface-50);">AI Configuration</h2>
      <p class="mt-2 text-sm" style="color: color-mix(in oklch, var(--color-surface-200) 55%, transparent);">
        Optionally configure an AI provider to get article summaries, scoring, and personalized recommendations.
      </p>
      <div class="mt-6 flex gap-3">
        <button class="action-btn px-4 py-2" onclick={() => handleAiChoice(true)}>
          Skip AI for now
        </button>
        <button class="btn preset-filled-primary-500" onclick={() => handleAiChoice(false)}>
          Configure later
        </button>
      </div>
    </div>

  {:else if step === 4}
    <div class="glass-card p-8 text-center">
      <div class="mb-6 inline-flex h-20 w-20 items-center justify-center rounded-full" style="background: color-mix(in oklch, var(--color-success-500) 12%, transparent); box-shadow: 0 0 30px -5px color-mix(in oklch, var(--color-success-500) 30%, transparent);">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--color-success-400);">
          <path d="M20 6 9 17l-5-5"/>
        </svg>
      </div>
      <h2 class="text-2xl font-bold" style="color: var(--color-surface-50);">You're All Set!</h2>
      <p class="mt-4" style="color: color-mix(in oklch, var(--color-surface-200) 60%, transparent);">
        Start reading your feeds. You can add more feeds anytime from the Feeds page.
      </p>
      <button class="btn preset-filled-primary-500 mt-8 inline-flex items-center gap-2" onclick={finishSetup} disabled={loading}>
        {#if loading}
          <svg class="animate-spin" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          Setting up...
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
          Start Reading
        {/if}
      </button>
    </div>
  {/if}
</div>