<script lang="ts">
  import { onMount } from 'svelte';
  import { addToast } from '$lib/stores/toast.svelte';
  import { fetchWithCsrf } from '$lib/client/csrf';

  type RecoveryArticle = {
    id: string;
    title: string;
    url: string;
    feedTitle: string;
    read: boolean;
    saved: boolean;
    hidden: boolean;
    rejected: boolean;
    thumbsDown: boolean;
    stateChangedAt?: number | null;
  };

  let articles = $state<RecoveryArticle[]>([]);
  let loading = $state(true);
  let errorMessage = $state('');
  let restoring = $state<Record<string, boolean>>({});
  let nextCursor = $state<string | null>(null);

  async function loadRecovery(append = false) {
    loading = !append;
    errorMessage = '';
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (append && nextCursor) params.set('cursor', nextCursor);
      const response = await fetch(`/api/article-state/recovery?${params}`);
      if (!response.ok) throw new Error('Recovery is unavailable right now.');
      const payload = (await response.json()) as {
        articles?: RecoveryArticle[];
        nextCursor?: string | null;
      };
      articles = append
        ? [...articles, ...(payload.articles || [])]
        : payload.articles || [];
      nextCursor = payload.nextCursor ?? null;
    } catch (error) {
      errorMessage =
        error instanceof Error ? error.message : 'Recovery failed.';
    } finally {
      loading = false;
    }
  }

  async function restore(article: RecoveryArticle) {
    if (restoring[article.id]) return;
    restoring = { ...restoring, [article.id]: true };
    try {
      const response = await fetchWithCsrf('/api/article-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          articleId: article.id,
          action: 'restore',
          state: { hidden: false, rejected: false },
        }),
      });
      if (!response.ok) throw new Error('Could not restore this article.');
      articles = articles.filter((item) => item.id !== article.id);
      addToast('Article restored to your feed', 'success');
    } catch (error) {
      addToast(
        error instanceof Error ? error.message : 'Restore failed',
        'error',
      );
    } finally {
      const { [article.id]: _pending, ...rest } = restoring;
      restoring = rest;
    }
  }

  function relativeTime(value?: number | null): string {
    if (!value) return 'Previously';
    const days = Math.floor((Date.now() - value) / 86_400_000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return `${days} days ago`;
  }

  onMount(() => void loadRecovery());
</script>

<svelte:head>
  <title>Recovery · Feed Me Maybe</title>
  <meta
    name="description"
    content="Restore articles you previously hid or rejected."
  />
</svelte:head>

<div class="mx-auto max-w-5xl">
  <div class="mb-8">
    <p class="eyebrow text-secondary-300">Review hidden and rejected</p>
    <h1 class="section-title">Recovery</h1>
    <p class="section-subtitle">
      Restore hidden, rejected, or disliked articles.
    </p>
  </div>

  {#if loading}
    <div class="glass-card flex min-h-48 items-center justify-center p-8">
      <div
        class="h-8 w-8 animate-spin rounded-full border-2 border-secondary-400 border-t-transparent"
      ></div>
    </div>
  {:else if errorMessage}
    <div class="glass-card p-8 text-center">
      <p class="text-error-300">{errorMessage}</p>
      <button
        type="button"
        class="btn preset-tonal mt-4"
        onclick={() => void loadRecovery()}>Try again</button
      >
    </div>
  {:else if articles.length === 0}
    <div class="glass-card p-10 text-center">
      <p class="text-lg font-semibold text-surface-100">
        No hidden or rejected articles
      </p>
      <p class="section-subtitle mt-2">
        Articles you restore will appear in your feeds again.
      </p>
    </div>
  {:else}
    <div class="space-y-3">
      {#each articles as article (article.id)}
        <article
          class="glass-card flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between md:p-5"
        >
          <div class="min-w-0">
            <div
              class="mb-2 flex flex-wrap items-center gap-2 text-xs text-surface-400"
            >
              <span
                class="rounded-full bg-error-500/10 px-2 py-1 text-error-300"
                >{article.rejected || article.thumbsDown
                  ? 'Rejected'
                  : 'Hidden'}</span
              >
              <span>{article.feedTitle || 'Unknown source'}</span>
              <span>·</span>
              <span>{relativeTime(article.stateChangedAt)}</span>
            </div>
            <a
              class="block font-semibold text-surface-100 no-underline transition hover:text-primary-300"
              href="/articles/{article.id}">{article.title}</a
            >
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <a
              class="btn preset-tonal no-underline"
              href="/articles/{article.id}">Review</a
            >
            <button
              type="button"
              class="btn preset-filled-secondary-500"
              onclick={() => void restore(article)}
              disabled={Boolean(restoring[article.id])}
              >{restoring[article.id] ? 'Restoring…' : 'Restore'}</button
            >
          </div>
        </article>
      {/each}
    </div>
    {#if nextCursor}
      <div class="flex justify-center py-8">
        <button
          type="button"
          class="btn preset-tonal"
          onclick={() => void loadRecovery(true)}>Load more</button
        >
      </div>
    {/if}
  {/if}
</div>
