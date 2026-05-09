<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import { formatContent, renderContent } from '$lib/utils/format';
  import { extractArticleImages } from '$lib/utils/article-images';
  import { addToast } from '$lib/stores/toast.svelte';
  import { page } from '$app/stores';
  import RedditComments from '$lib/components/RedditComments.svelte';
  type InteractionType = 'thumbs_up' | 'thumbs_down' | 'save' | 'hide';
  type ArticleData = {
    id: string;
    url: string;
    title: string;
    author?: string | null;
    summary?: string | null;
    content?: string | null;
    image_url?: string | null;
    feed_title?: string | null;
    feed_url?: string | null;
    feed_site_url?: string | null;
    feed_use_proxy?: boolean | number | null;
    published_at?: number | null;
    ai_summary?: string | null;
    thumbs_up?: boolean | null;
    thumbs_down?: boolean | null;
    saved?: boolean | null;
    hidden?: boolean | null;
    archive_url?: string | null;
  };

  let { data: pageData } = $props<{
    data: { article: ArticleData; proxyBaseUrl?: string | null };
  }>();

  const article = $derived(pageData.article);
  const mode = $derived($page.url.searchParams.get('mode') || 'app');

  // Reactive interaction state
  let liked = $state(false);
  let disliked = $state(false);
  let saved = $state(false);
  let hidden = $state(false);
  let dismissing = $state(false);
  let pendingAction = $state<InteractionType | null>(null);
  let iframeLoading = $state(true);
  let lightboxOpen = $state(false);
  let lightboxIndex = $state(0);
  let articleContentEl = $state<HTMLDivElement | null>(null);
  let lightboxBackdropEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    liked = !!article.thumbs_up;
    disliked = !!article.thumbs_down;
    saved = !!article.saved;
    hidden = !!article.hidden;
  });

  const isEmbeddedMode = $derived(mode === 'iframe' || mode === 'proxy');
  const isReaderMode = $derived(mode === 'app' || mode === 'archive');
  const isRedditPost = $derived(
    Boolean(
      article.url?.includes('reddit.com') &&
      article.url?.includes('/comments/'),
    ),
  );
  const renderedArticleContent = $derived(
    article.content ? renderContent(article.content) : '',
  );
  const articleImages = $derived(
    extractArticleImages({
      articleUrl: article.url,
      heroUrl: article.image_url,
      content: article.content,
    }),
  );
  const activeLightboxImage = $derived(articleImages[lightboxIndex] ?? null);
  const sourceHref = $derived(
    mode === 'archive'
      ? `https://archive.is/${encodeURIComponent(article.url)}`
      : article.url,
  );

  // Prevent main scroll when in iframe/proxy mode
  $effect(() => {
    if (isEmbeddedMode) {
      const main = document.querySelector('main');
      if (main) main.style.overflow = 'hidden';
      return () => {
        if (main) main.style.overflow = '';
      };
    }
  });

  $effect(() => {
    if (!lightboxOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  });

  $effect(() => {
    if (!articleContentEl) return;

    const onClick = (event: MouseEvent) => handleContentClick(event);
    articleContentEl.addEventListener('click', onClick);

    return () => {
      articleContentEl?.removeEventListener('click', onClick);
    };
  });

  $effect(() => {
    if (!lightboxBackdropEl) return;

    const onClick = (event: MouseEvent) => {
      if (event.target === lightboxBackdropEl) {
        closeLightbox();
      }
    };

    lightboxBackdropEl.addEventListener('click', onClick);

    return () => {
      lightboxBackdropEl?.removeEventListener('click', onClick);
    };
  });

  // Check if the hero image is already the first thing in the content to avoid duplicates
  function contentFirstImg(): string | null {
    if (!article.content) return null;

    const htmlMatch = article.content.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (htmlMatch) return htmlMatch[1];

    const markdownMatch = article.content.match(
      /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
    );
    return markdownMatch ? markdownMatch[1] : null;
  }

  function shouldShowHero(): boolean {
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
  }

  function openLightbox(index: number) {
    if (!articleImages.length) return;
    lightboxIndex = Math.max(0, Math.min(index, articleImages.length - 1));
    lightboxOpen = true;
  }

  function closeLightbox() {
    lightboxOpen = false;
  }

  function goToLightboxImage(delta: number) {
    if (!articleImages.length) return;
    lightboxIndex =
      (lightboxIndex + delta + articleImages.length) % articleImages.length;
  }

  function handleContentClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    const image = target?.closest('img') as HTMLImageElement | null;
    if (!image) return;

    const src = image.getAttribute('src');
    if (!src) return;

    const imageIndex = articleImages.findIndex((item) => item.src === src);
    if (imageIndex === -1) return;

    event.preventDefault();
    openLightbox(imageIndex);
  }

  function handleLightboxKeydown(event: KeyboardEvent) {
    if (!lightboxOpen) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      closeLightbox();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goToLightboxImage(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      goToLightboxImage(1);
    }
  }

  async function interact(type: InteractionType) {
    if (pendingAction) return;

    // Optimistic UI updates
    const prevLiked = liked;
    const prevDisliked = disliked;
    const prevSaved = saved;
    const prevHidden = hidden;
    const prevDismissing = dismissing;
    pendingAction = type;

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
      dismissing = true;
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
      dismissing = prevDismissing;
      addToast('Action failed', 'error');
    } finally {
      pendingAction = null;
    }
  }

  const iframeUrl = $derived(
    mode === 'proxy'
      ? `/api/proxy?url=${encodeURIComponent(article.url)}`
      : article.url,
  );

  let touchStartX = 0;
  let touchStartY = 0;

  function handlePointerDown(e: PointerEvent) {
    if (!e.isPrimary) return;
    touchStartX = e.clientX;
    touchStartY = e.clientY;
  }

  function handlePointerUp(e: PointerEvent) {
    if (!e.isPrimary || !touchStartX) return;
    const dx = e.clientX - touchStartX;
    const dy = e.clientY - touchStartY;
    touchStartX = 0;
    touchStartY = 0;

    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      if (dx < 0) interact('hide');
      else interact('save');
    }
  }
</script>

<svelte:window onkeydown={handleLightboxKeydown} />

<div
  class={isEmbeddedMode
    ? 'absolute inset-0 z-0 bg-surface-950'
    : 'mx-auto max-w-4xl'}
  style="touch-action: pan-y;"
  role="presentation"
  onpointerdown={handlePointerDown}
  onpointerup={handlePointerUp}
>
  {#if isReaderMode}
    <div class="mb-4 flex items-center justify-between">
      <a
        href="/"
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
  {/if}

  {#if isEmbeddedMode}
    <div class="relative h-full w-full overflow-hidden" in:fade>
      {#if iframeLoading}
        <div
          class="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-surface-950/50 backdrop-blur-sm z-10"
        >
          <div
            class="h-8 w-8 animate-spin rounded-full border-4 border-primary-500 border-t-transparent"
          ></div>
          <p class="text-sm font-medium text-surface-200">
            {mode === 'proxy' ? 'Fetching via Proxy...' : 'Loading Article...'}
          </p>
          {#if mode === 'iframe'}
            <p class="max-w-xs text-center text-xs text-surface-400">
              If the site remains blank, it may be blocking iframes. Try
              switching to <strong>Proxy</strong> mode in settings.
            </p>
          {/if}
        </div>
      {/if}
      <iframe
        src={iframeUrl}
        title={article.title}
        class="h-full w-full border-none"
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
        referrerpolicy="no-referrer"
        onload={() => (iframeLoading = false)}
      ></iframe>
    </div>
  {:else}
    <article
      class="glass-card glass-card-hover overflow-hidden"
      in:fly={{ y: 16, duration: 350 }}
    >
      {#if dismissing}
        <div class="flex min-h-[32rem] flex-col items-center justify-center gap-4 p-8 text-center">
          <div
            class="h-12 w-12 animate-pulse rounded-full border border-primary-500/40 bg-primary-500/10"
          ></div>
          <div>
            <p class="text-lg font-semibold text-surface-50">Hiding article...</p>
            <p class="mt-1 text-sm text-surface-300">
              The page will leave as soon as the server confirms it.
            </p>
          </div>
        </div>
      {:else}
        {#if shouldShowHero()}
          <button
            type="button"
            class="group relative block w-full overflow-hidden text-left"
            onclick={() => openLightbox(0)}
            aria-label="Open article image"
          >
            <img
              src={article.image_url}
              alt=""
              class="h-64 w-full object-cover transition-transform duration-300 group-hover:scale-[1.01] md:h-80 cursor-zoom-in"
              loading="lazy"
            />
            <div
              class="pointer-events-none absolute inset-0 bg-gradient-to-t from-[var(--color-surface-950)] via-transparent to-transparent opacity-80"
            ></div>
          </button>
        {/if}

        <div class="p-5 pb-28 md:p-8 md:pb-32">
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
              <div
                class="text-sm leading-relaxed prose prose-sm max-w-none"
                style="color: color-mix(in oklch, var(--color-surface-100) 75%, transparent);"
              >
                {@html formatContent(article.ai_summary)}
              </div>
            </div>
          {/if}

          <div
            class="prose prose-sm max-w-none prose-glass [&_img]:cursor-zoom-in"
            bind:this={articleContentEl}
          >
            {#if article.content}
              {@html renderedArticleContent}
            {:else if article.summary}
              <div class="leading-relaxed">{@html formatContent(article.summary)}</div>
            {:else}
              <p
                class="italic"
                style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);"
              >
                No content available.
              </p>
            {/if}
          </div>

          {#if isRedditPost}
            <RedditComments
              permalink={article.url}
              useProxy={Boolean(article.feed_use_proxy)}
              proxyBaseUrl={pageData.proxyBaseUrl}
            />
          {/if}
        </div>
      {/if}
    </article>
  {/if}

  {#if lightboxOpen && activeLightboxImage}
    <div
      class="fixed inset-0 z-[70] bg-black/95"
      role="dialog"
      tabindex="0"
      aria-modal="true"
      aria-label="Article image viewer"
      in:fade={{ duration: 160 }}
      bind:this={lightboxBackdropEl}
    >
      <div class="flex h-full w-full flex-col">
        <div class="flex items-center justify-between gap-3 p-3 md:p-4">
          <div class="text-xs font-medium text-white/70">
            {lightboxIndex + 1} / {articleImages.length}
          </div>
          <button
            type="button"
            class="action-btn h-10 w-10 rounded-full !p-0 !bg-white/10 !text-white hover:!bg-white/15"
            onclick={closeLightbox}
            aria-label="Close image viewer"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.25"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        <div class="flex min-h-0 flex-1 items-center justify-center px-3 pb-3 md:px-6 md:pb-6">
          {#if articleImages.length > 1}
            <button
              type="button"
              class="absolute left-3 top-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-black/40 p-3 text-white/90 backdrop-blur-sm transition hover:bg-black/60 md:left-6"
              onclick={() => goToLightboxImage(-1)}
              aria-label="Previous image"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
              >
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
          {/if}

          <div class="flex h-full w-full min-h-0 min-w-0 items-center justify-center">
            <img
              src={activeLightboxImage.src}
              alt=""
              class="max-h-full max-w-full select-none object-contain"
              draggable="false"
            />
          </div>

          {#if articleImages.length > 1}
            <button
              type="button"
              class="absolute right-3 top-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-black/40 p-3 text-white/90 backdrop-blur-sm transition hover:bg-black/60 md:right-6"
              onclick={() => goToLightboxImage(1)}
              aria-label="Next image"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          {/if}
        </div>

        {#if articleImages.length > 1}
          <div class="border-t border-white/10 bg-black/65 px-3 py-3 backdrop-blur-md md:px-6">
            <div class="flex gap-2 overflow-x-auto pb-1">
              {#each articleImages as image, index (image.src)}
                <button
                  type="button"
                  class="relative h-16 w-24 flex-none overflow-hidden rounded-sm border transition md:h-20 md:w-28 {index === lightboxIndex
                    ? 'border-primary-400 ring-1 ring-primary-400'
                    : 'border-white/10 opacity-70 hover:opacity-100'}"
                  onclick={() => (lightboxIndex = index)}
                  aria-label={`Show image ${index + 1}`}
                >
                  <img
                    src={image.src}
                    alt=""
                    class="h-full w-full object-cover"
                    draggable="false"
                  />
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Floating Action Bar -->
  <div
    class="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-sm border p-1.5 shadow-2xl backdrop-blur-xl"
    style="background: color-mix(in oklch, var(--color-surface-900) 80%, transparent); border-color: color-mix(in oklch, var(--color-surface-100) 15%, transparent);"
    in:fly={{ y: 20, duration: 400, delay: 400 }}
  >
    <button
      type="button"
      class="action-btn h-9 px-3 rounded-full"
      disabled={Boolean(pendingAction)}
      onclick={() => window.history.back()}
      title="Back"
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
      <span class="ml-1.5 hidden sm:inline">Back</span>
    </button>

    <div class="w-px h-6 bg-surface-100/10 mx-1"></div>

    <div
      class="flex items-center gap-1 border-r pr-1.5 mr-0.5"
      style="border-color: color-mix(in oklch, var(--color-surface-100) 10%, transparent);"
    >
      <button
        type="button"
        class="action-btn h-9 w-9 rounded-full !p-0 {liked
          ? '!text-primary-400 !bg-primary-500/10 !border-primary-500/30'
          : ''}"
        disabled={Boolean(pendingAction)}
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
        disabled={Boolean(pendingAction)}
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
      class="action-btn h-9 px-3 rounded-full !hidden lg:!inline-flex {saved
        ? '!text-success-400 !bg-success-500/10 !border-success-500/30'
        : ''}"
      disabled={Boolean(pendingAction)}
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
      href={sourceHref}
      target="_blank"
      rel="noopener noreferrer"
      class="action-btn h-9 px-3 rounded-full no-underline hover:!text-primary-300"
      title={mode === 'archive'
        ? 'Open Archived Source'
        : 'Open Original Source'}
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
      class="action-btn h-9 px-3 rounded-full !hidden lg:!inline-flex hover:!text-error-400 {hidden
        || dismissing
        ? 'opacity-50 pointer-events-none'
        : ''}"
      disabled={Boolean(pendingAction)}
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
