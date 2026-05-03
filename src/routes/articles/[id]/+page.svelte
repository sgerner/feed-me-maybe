<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { addToast } from '$lib/stores/toast.svelte';
  import { page } from '$app/stores';
  let { data: pageData } = $props();

  const article = $derived(pageData.article);
  const mode = $derived($page.url.searchParams.get('mode') || 'app');

  // Reactive interaction state
  let liked = $state(!!article.thumbs_up);
  let disliked = $state(!!article.thumbs_down);
  let saved = $state(!!article.saved);
  let hidden = $state(!!article.hidden);

  // Check if the hero image is already the first thing in the content to avoid duplicates
  const contentFirstImg = $derived(() => {
    if (!article.content) return null;
    const match = article.content.match(/<img[^>]+src=["']([^"']+)["']/i);
    return match ? match[1] : null;
  });

  const shouldShowHero = $derived(() => {
    if (!article.image_url) return false;
    const firstImg = contentFirstImg();
    if (!firstImg) return true;

    // Normalize and compare
    try {
      const heroUrl = new URL(article.image_url).pathname;
      const firstUrl = new URL(firstImg).pathname;
      return heroUrl !== firstUrl;
    } catch {
      return article.image_url !== firstImg;
    }
  });

  async function interact(type: string) {
    // Optimistic UI updates
    const prevLiked = liked;
    const prevDisliked = disliked;
    const prevSaved = saved;
    const prevHidden = hidden;

    if (type === 'thumbs_up') {
      liked = !liked;
      if (liked) disliked = false;
    } else if (type === 'thumbs_down') {
      disliked = !disliked;
      if (disliked) liked = false;
    } else if (type === 'save') {
      saved = !saved;
    } else if (type === 'hide') {
      hidden = true;
    }

    try {
      const actualType =
        type === 'save' && prevSaved
          ? 'unsave'
          : type === 'hide' && prevHidden
            ? 'unhide'
            : type;

      const res = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ articleId: article.id, type: actualType }),
      });
      if (res.ok) {
        const labels: Record<string, string> = {
          hide: 'Hidden',
          save: 'Saved',
          unsave: 'Removed from Saved',
          thumbs_up: 'Liked',
          thumbs_down: 'Disliked',
        };
        addToast(labels[actualType] || type, 'success');

        if (type === 'hide') {
          // If hidden, go back after a delay
          setTimeout(() => {
            window.history.back();
          }, 800);
        }
      } else {
        throw new Error();
      }
    } catch {
      // Revert on failure
      liked = prevLiked;
      disliked = prevDisliked;
      saved = prevSaved;
      hidden = prevHidden;
      addToast('Action failed', 'error');
    }
  }
</script>

<div class="mx-auto max-w-4xl">
  <div class="mb-4 flex items-center justify-between">
    <a
      href="/today"
      class="inline-flex items-center gap-1.5 text-sm no-underline transition-colors hover:text-primary-400"
      style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"><path d="m15 18-6-6 6-6" /></svg
      >
      Back
    </a>
  </div>

  {#if mode === 'iframe'}
    <div class="glass-card flex flex-col overflow-hidden h-[80vh]" in:fade>
      <iframe
        src={article.url}
        title={article.title}
        class="w-full flex-1 border-none bg-white"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
      ></iframe>
    </div>
  {:else}
    <article
      class="glass-card glass-card-hover overflow-hidden"
      in:fly={{ y: 16, duration: 350 }}
    >
      {#if shouldShowHero()}
        <div class="relative">
          <img
            src={article.image_url}
            alt=""
            class="h-64 w-full object-cover md:h-80"
            loading="lazy"
          />
          <div
            class="absolute inset-0 bg-gradient-to-t from-[var(--color-surface-950)] via-transparent to-transparent opacity-80"
          ></div>
        </div>
      {/if}

      <div class="p-5 md:p-8">
        <div class="mb-6">
          <div
            class="flex flex-wrap items-center gap-2 text-xs"
            style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);"
          >
            <span
              class="inline-flex items-center gap-1.5 px-2 py-0.5 font-medium"
              style="background: color-mix(in oklch, var(--color-primary-500) 10%, transparent); color: var(--color-primary-300); border-radius: 2px;"
            >
              {article.feed_title || 'Unknown Feed'}
            </span>
            {#if article.author}
              <span class="flex items-center gap-1">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  ><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle
                    cx="12"
                    cy="7"
                    r="4"
                  /></svg
                >
                {article.author}
              </span>
            {/if}
            <span class="flex items-center gap-1">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                ><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line
                  x1="16"
                  y1="2"
                  x2="16"
                  y2="6"
                /><line x1="8" y1="2" x2="8" y2="6" /><line
                  x1="3"
                  y1="10"
                  x2="21"
                  y2="10"
                /></svg
              >
              {article.published_at
                ? new Date(article.published_at).toLocaleDateString(undefined, {
                    weekday: 'short',
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })
                : ''}
            </span>
            {#if article.feed_site_url}
              <a
                href={article.feed_site_url}
                class="flex items-center gap-1 underline transition-colors hover:text-primary-400"
                target="_blank"
                rel="noopener"
              >
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
                Visit Source
              </a>
            {/if}
          </div>
          <h1
            class="mt-3 text-2xl font-bold leading-tight md:text-3xl"
            style="color: var(--color-surface-50); text-shadow: 0 2px 4px rgba(0,0,0,0.3);"
          >
            {article.title}
          </h1>
        </div>

        {#if article.ai_summary}
          <div
            class="mb-6 border p-5"
            style="background: color-mix(in oklch, var(--color-secondary-500) 6%, transparent); border-color: color-mix(in oklch, var(--color-secondary-500) 15%, transparent); border-radius: 2px;"
          >
            <div
              class="mb-2 flex items-center gap-2 text-sm font-semibold"
              style="color: var(--color-secondary-300);"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                ><path
                  d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"
                /><path d="M8.5 8.5v.01" /><path d="M16 15.5v.01" /><path
                  d="M12 12v.01"
                /><path d="M11 17v.01" /><path d="M7 14v.01" /></svg
              >
              AI Summary
            </div>
            <p
              class="text-sm leading-relaxed"
              style="color: color-mix(in oklch, var(--color-surface-100) 75%, transparent);"
            >
              {article.ai_summary}
            </p>
          </div>
        {/if}

        <div class="prose prose-sm max-w-none prose-glass">
          {#if article.content}
            {@html article.content}
          {:else if article.summary}
            <p class="leading-relaxed">{article.summary}</p>
          {:else}
            <p
              class="italic"
              style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);"
            >
              No content available.
            </p>
          {/if}
        </div>
      </div>
    </article>
  {/if}

  <!-- Floating Action Bar -->
  <div
    class="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border p-1.5 shadow-2xl backdrop-blur-xl"
    style="background: color-mix(in oklch, var(--color-surface-900) 80%, transparent); border-color: color-mix(in oklch, var(--color-surface-100) 15%, transparent);"
    in:fly={{ y: 20, duration: 400, delay: 400 }}
  >
    <div
      class="flex items-center gap-1 border-r pr-1.5 mr-0.5"
      style="border-color: color-mix(in oklch, var(--color-surface-100) 10%, transparent);"
    >
      <button
        type="button"
        class="action-btn h-9 w-9 rounded-full !p-0 {liked
          ? '!text-primary-400 !bg-primary-500/10 !border-primary-500/30'
          : ''}"
        onclick={() => interact('thumbs_up')}
        title="Like"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill={liked ? 'currentColor' : 'none'}
          stroke="currentColor"
          stroke-width="2"
          ><path d="M7 10v12" /><path
            d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"
          /></svg
        >
      </button>
      <button
        type="button"
        class="action-btn h-9 w-9 rounded-full !p-0 {disliked
          ? '!text-error-400 !bg-error-500/10 !border-error-500/30'
          : ''}"
        onclick={() => interact('thumbs_down')}
        title="Dislike"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill={disliked ? 'currentColor' : 'none'}
          stroke="currentColor"
          stroke-width="2"
          ><path d="M17 14V2" /><path
            d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z"
          /></svg
        >
      </button>
    </div>

    <button
      type="button"
      class="action-btn h-9 px-3 rounded-full {saved
        ? '!text-success-400 !bg-success-500/10 !border-success-500/30'
        : ''}"
      onclick={() => interact('save')}
      title="Save Article"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill={saved ? 'currentColor' : 'none'}
        stroke="currentColor"
        stroke-width="2"
        ><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" /></svg
      >
      <span class="ml-1.5 hidden sm:inline">{saved ? 'Saved' : 'Save'}</span>
    </button>

    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      class="action-btn h-9 px-3 rounded-full no-underline hover:!text-primary-300"
      title="Open Original Source"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
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
      <span class="ml-1.5 hidden sm:inline">Source</span>
    </a>

    <button
      type="button"
      class="action-btn h-9 px-3 rounded-full hover:!text-error-400 {hidden
        ? 'opacity-50 pointer-events-none'
        : ''}"
      onclick={() => interact('hide')}
      title="Hide Article"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        ><path d="M3 6h18" /><path
          d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"
        /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg
      >
      <span class="ml-1.5 hidden sm:inline">Hide</span>
    </button>
  </div>
</div>
