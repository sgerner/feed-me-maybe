<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    canTriggerSingleKeyShortcut,
    getSingleKeyShortcutsEnabled,
  } from '#lib/utils/keyboard-shortcuts.ts';
  import {
    extractArticleHeadings,
    formatContent,
    normalizeFragmentHref,
    normalizeUserContentId,
    renderContent,
    shouldToggleReaderOutline,
    type ReaderHeading,
  } from '#lib/utils/format.ts';
  import { extractArticleImages } from '#lib/utils/article-images.ts';
  import { addToast } from '#lib/stores/toast.svelte.ts';
  import { fetchWithCsrf } from '#lib/client/csrf.ts';
  import {
    executeArticleTriage,
    shareArticleLink,
    type TriageAction,
  } from '#lib/client/triage.ts';
  import { cacheArticles, getCachedArticles } from '#lib/offline/index.ts';
  import { page } from '$app/state';
  import RedditComments from '#lib/components/RedditComments.svelte';
  type InteractionType =
    'thumbs_up' | 'thumbs_down' | 'save' | 'hide' | 'read' | 'unread';
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
    feed_open_mode?: string | null;
    published_at?: number | null;
    fetched_at?: number | null;
    feed_id?: string | null;
    read?: boolean | null;
    ai_summary?: string | null;
    thumbs_up?: boolean | null;
    thumbs_down?: boolean | null;
    saved?: boolean | null;
    hidden?: boolean | null;
    explicitly_hidden?: boolean | number | null;
    rejected?: boolean | null;
    archive_url?: string | null;
  };

  let { data: pageData } = $props<{
    data: {
      article: ArticleData;
      proxyBaseUrl?: string | null;
      neighbors?: { previous: string | null; next: string | null };
      archiveFailed?: boolean;
    };
  }>();

  const article = $derived(pageData.article);
  const mode = $derived(page.url.searchParams.get('mode') || 'app');

  // Reactive interaction state
  let liked = $state(false);
  let disliked = $state(false);
  let saved = $state(false);
  let hidden = $state(false);
  let explicitlyHidden = $state(false);
  let read = $state(false);
  let pendingAction = $state<InteractionType | null>(null);
  let iframeLoading = $state(true);
  let lightboxOpen = $state(false);
  let lightboxIndex = $state(0);
  let articleContentEl = $state<HTMLDivElement | null>(null);
  let readerArticleEl = $state<HTMLElement | null>(null);
  let lightboxBackdropEl = $state<HTMLDivElement | null>(null);
  let lightboxPreviouslyFocused: HTMLElement | null = null;
  let readerMoreOpen = $state(false);
  let readingProgress = $state(0);
  let fetchedContent = $state<string | null>(null);
  let fetchingContent = $state(false);
  let fetchContentError = $state('');
  let fullTextConfirmed = $state(false);
  let showSummaryInstead = $state(false);
  let heroImageBroken = $state(false);
  let outlineHeadings = $state<ReaderHeading[]>([]);
  let outlineOpen = $state(true);
  let activeHeadingId = $state('');
  let loadFullTextController: AbortController | null = null;
  let activeArticleId = '';
  let restoringScroll = false;

  let readerQueue = $state<{ ids: string[]; source: string } | null>(null);
  let dismissedQueueIds = $state<string[]>([]);
  let fallbackReturnPath = $state('/');

  const readerIndex = $derived(readerQueue?.ids.indexOf(article.id) ?? -1);

  const previousId = $derived.by(() => {
    if (readerIndex > 0 && readerQueue) {
      for (let idx = readerIndex - 1; idx >= 0; idx--) {
        const candidate = readerQueue.ids[idx];
        if (candidate && !dismissedQueueIds.includes(candidate)) {
          return candidate;
        }
      }
    }
    const fallbackPrev = pageData.neighbors?.previous ?? null;
    return fallbackPrev &&
      fallbackPrev !== article.id &&
      !dismissedQueueIds.includes(fallbackPrev)
      ? fallbackPrev
      : null;
  });

  const nextId = $derived.by(() => {
    if (readerIndex >= 0 && readerQueue) {
      for (let idx = readerIndex + 1; idx < readerQueue.ids.length; idx++) {
        const candidate = readerQueue.ids[idx];
        if (candidate && !dismissedQueueIds.includes(candidate)) {
          return candidate;
        }
      }
    }
    const fallbackNext = pageData.neighbors?.next ?? null;
    return fallbackNext &&
      fallbackNext !== article.id &&
      !dismissedQueueIds.includes(fallbackNext)
      ? fallbackNext
      : null;
  });

  const returnPath = $derived(
    readerIndex >= 0
      ? readerQueue?.source || fallbackReturnPath
      : fallbackReturnPath,
  );
  const articleContent = $derived(fetchedContent ?? article.content);

  function stripPlainText(value: string | null | undefined): string {
    if (!value) return '';
    return value
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const canToggleSummaryAndFullText = $derived.by(() => {
    const bodyText = stripPlainText(articleContent);
    const summaryText = stripPlainText(article.summary);
    return (
      Boolean(bodyText && summaryText && bodyText !== summaryText) &&
      (Boolean(fetchedContent) ||
        fullTextConfirmed ||
        bodyText.length > summaryText.length)
    );
  });

  const activeBodyContent = $derived(
    showSummaryInstead && article.summary ? null : articleContent,
  );

  let fontScale = $state(1);
  let isSpeaking = $state(false);

  const READING_PROGRESS_STORAGE_KEY = 'feed-me-maybe:reading-progress';
  const MAX_READING_PROGRESS_ENTRIES = 200;

  type SavedReadingProgress = {
    ratio: number;
    scrollTop: number;
    updatedAt: number;
  };

  function readProgressMap(): Record<string, SavedReadingProgress> {
    try {
      const raw = localStorage.getItem(READING_PROGRESS_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, SavedReadingProgress>)
        : {};
    } catch {
      return {};
    }
  }

  function saveArticleScrollProgress(
    targetArticleId: string,
    scrollTop: number,
    maxScroll: number,
  ): void {
    if (!targetArticleId || restoringScroll) return;
    try {
      const map = readProgressMap();
      if (scrollTop <= 0 && !map[targetArticleId]) return;
      map[targetArticleId] = {
        ratio:
          maxScroll > 0 ? Math.min(1, Math.max(0, scrollTop / maxScroll)) : 0,
        scrollTop: Math.max(0, Math.round(scrollTop)),
        updatedAt: Date.now(),
      };
      const entries = Object.entries(map);
      if (entries.length > MAX_READING_PROGRESS_ENTRIES) {
        entries.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
        const trimmed = Object.fromEntries(
          entries.slice(0, MAX_READING_PROGRESS_ENTRIES),
        );
        localStorage.setItem(
          READING_PROGRESS_STORAGE_KEY,
          JSON.stringify(trimmed),
        );
      } else {
        localStorage.setItem(READING_PROGRESS_STORAGE_KEY, JSON.stringify(map));
      }
    } catch {
      // Storage quota or privacy mode must not break scrolling.
    }
  }

  async function restoreArticleScrollProgress(
    targetArticleId: string,
  ): Promise<void> {
    if (typeof document === 'undefined') return;
    restoringScroll = true;
    await tick();
    const main = document.querySelector<HTMLElement>('#main-content, main');
    if (!main) {
      restoringScroll = false;
      return;
    }
    main.scrollLeft = 0;
    const savedProgress = readProgressMap()[targetArticleId];
    const max = Math.max(0, main.scrollHeight - main.clientHeight);
    if (
      savedProgress &&
      (savedProgress.scrollTop > 0 || savedProgress.ratio > 0)
    ) {
      const targetTop =
        max > 0 && savedProgress.ratio > 0
          ? Math.round(savedProgress.ratio * max)
          : savedProgress.scrollTop;
      main.scrollTop = Math.max(0, Math.min(max || targetTop, targetTop));
    } else {
      main.scrollTop = 0;
    }
    const updatedMax = Math.max(0, main.scrollHeight - main.clientHeight);
    readingProgress =
      updatedMax > 0 ? Math.round((main.scrollTop / updatedMax) * 100) : 0;
    restoringScroll = false;
  }

  function syncQueueSessionStorage(nextDismissed: string[]): void {
    if (!readerQueue) return;
    try {
      const filteredIds = readerQueue.ids.filter(
        (id) => !nextDismissed.includes(id),
      );
      sessionStorage.setItem(
        'feed-me-maybe:reader-queue',
        JSON.stringify({
          ids: filteredIds,
          source: readerQueue.source,
        }),
      );
    } catch {
      // Ignore storage errors
    }
  }

  function markQueueArticleDismissed(id: string, dismissed: boolean): void {
    const next = dismissed
      ? dismissedQueueIds.includes(id)
        ? dismissedQueueIds
        : [...dismissedQueueIds, id]
      : dismissedQueueIds.filter((item) => item !== id);
    dismissedQueueIds = next;
    syncQueueSessionStorage(next);
  }

  $effect(() => {
    const nextArticleId = article.id;
    liked = !!article.thumbs_up;
    disliked = !!article.thumbs_down || !!article.rejected;
    saved = !!article.saved;
    hidden = !!article.hidden;
    explicitlyHidden = Boolean(article.explicitly_hidden);
    read = !!article.read;

    if (activeArticleId !== nextArticleId) {
      const hadPreviousArticle = activeArticleId !== '';
      activeArticleId = nextArticleId;
      loadFullTextController?.abort();
      loadFullTextController = null;
      fetchedContent = null;
      fetchingContent = false;
      fetchContentError = '';
      fullTextConfirmed = false;
      showSummaryInstead = false;
      heroImageBroken = false;
      outlineHeadings = [];
      activeHeadingId = '';
      readerMoreOpen = false;
      lightboxOpen = false;
      lightboxIndex = 0;
      iframeLoading = true;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      isSpeaking = false;
      if (hadPreviousArticle) {
        void restoreArticleScrollProgress(nextArticleId);
      }
    }
  });

  const isEmbeddedMode = $derived(mode === 'iframe' || mode === 'proxy');
  const isReaderMode = $derived(mode === 'app' || mode === 'archive');
  const hasOutline = $derived(isReaderMode && outlineHeadings.length >= 2);
  const minOutlineHeadingLevel = $derived(
    outlineHeadings.length > 0
      ? Math.min(...outlineHeadings.map((heading) => heading.level))
      : 2,
  );
  const reactionsLocked = $derived(explicitlyHidden || disliked);
  const canRestore = $derived(hidden || explicitlyHidden || disliked);
  const isRedditPost = $derived(
    Boolean(
      article.url?.includes('reddit.com') &&
      article.url?.includes('/comments/'),
    ),
  );
  const renderedArticleContent = $derived(
    activeBodyContent ? renderContent(activeBodyContent, article.url) : '',
  );
  const articleImages = $derived(
    extractArticleImages({
      articleUrl: article.url,
      heroUrl: heroImageBroken ? null : article.image_url,
      content: activeBodyContent,
    }),
  );
  const activeLightboxImage = $derived(articleImages[lightboxIndex] ?? null);
  const sourceHref = $derived(
    mode === 'archive'
      ? article.archive_url ||
          `https://archive.is/${encodeURIComponent(article.url)}`
      : article.url,
  );

  function offlineScope(): string {
    return String(page.data.userId || 'admin');
  }

  type ReaderStateSnapshot = {
    read: boolean;
    saved: boolean;
    hidden: boolean;
    thumbsUp: boolean;
    thumbsDown: boolean;
  };

  async function cacheReaderState(
    state: ReaderStateSnapshot,
    targetId = article.id,
  ): Promise<void> {
    if (article.id !== targetId) return;
    try {
      const scope = offlineScope();
      const candidateContent = String(articleContent || article.content || '');
      let bestContent = candidateContent;
      const existing = (await getCachedArticles(scope)).find(
        (item) => item.id === targetId,
      );
      if (existing?.content) {
        const existingPlainLen = stripPlainText(existing.content).length;
        const candidatePlainLen = stripPlainText(candidateContent).length;
        const candidateHasMoreIds =
          (candidateContent.match(/\bid="user-content-/gi) ?? []).length >
          (existing.content.match(/\bid="user-content-/gi) ?? []).length;
        if (
          existingPlainLen > candidatePlainLen ||
          (existing.content.length > candidateContent.length &&
            !candidateHasMoreIds)
        ) {
          bestContent = existing.content;
        }
      }
      if (article.id !== targetId) return;
      await cacheArticles(scope, [
        {
          id: article.id,
          feed_id: article.feed_id,
          url: article.url,
          title: article.title,
          summary: article.summary ?? '',
          content: bestContent,
          image_url: article.image_url,
          published_at: article.published_at,
          fetched_at: article.fetched_at,
          feed_title: article.feed_title,
          feed_url: article.feed_url,
          feed_site_url: article.feed_site_url,
          feed_open_mode: article.feed_open_mode,
          read: state.read,
          saved: state.saved,
          hidden: state.hidden,
          thumbs_up: state.thumbsUp,
          thumbs_down: state.thumbsDown,
        },
      ]);
    } catch {
      // IndexedDB is a convenience cache; it must not fail an online action.
    }
  }

  onMount(() => {
    try {
      const fromParam = page.url.searchParams.get('from');
      if (
        fromParam &&
        fromParam.startsWith('/') &&
        !fromParam.startsWith('//') &&
        !fromParam.includes('\\')
      ) {
        fallbackReturnPath = fromParam;
      } else if (document.referrer) {
        const refUrl = new URL(document.referrer);
        if (
          refUrl.origin === location.origin &&
          !refUrl.pathname.startsWith('/articles/') &&
          !refUrl.pathname.startsWith('/login')
        ) {
          fallbackReturnPath = `${refUrl.pathname}${refUrl.search}`;
        }
      }
    } catch {
      // Keep default '/'
    }

    try {
      const stored = JSON.parse(
        sessionStorage.getItem('feed-me-maybe:reader-queue') || 'null',
      );
      if (
        Array.isArray(stored?.ids) &&
        stored.ids.every((id: unknown) => typeof id === 'string') &&
        stored.ids.includes(article.id) &&
        typeof stored.source === 'string' &&
        stored.source.startsWith('/') &&
        !stored.source.startsWith('//') &&
        !stored.source.includes('\\') &&
        new URL(stored.source, location.origin).origin === location.origin
      ) {
        readerQueue = stored;
      }
    } catch {
      // The fallback order comes from the current feed.
    }

    try {
      const rawScale = localStorage.getItem('feed-me-maybe:reader-scale');
      if (rawScale !== null && rawScale.trim() !== '') {
        const savedScale = Number(rawScale);
        if (Number.isFinite(savedScale) && savedScale > 0) {
          fontScale = Math.max(0.9, Math.min(1.25, savedScale));
        }
      }
    } catch {
      // Reader controls remain useful when storage is unavailable.
    }

    const main = document.querySelector<HTMLElement>('#main-content, main');
    void restoreArticleScrollProgress(article.id);

    const updateProgress = () => {
      if (!main) return;
      const max = Math.max(0, main.scrollHeight - main.clientHeight);
      readingProgress = max > 0 ? Math.round((main.scrollTop / max) * 100) : 0;
      saveArticleScrollProgress(article.id, main.scrollTop, max);
      syncActiveHeading(main);
    };

    main?.addEventListener('scroll', updateProgress, { passive: true });

    return () => {
      main?.removeEventListener('scroll', updateProgress);
      loadFullTextController?.abort();
      loadFullTextController = null;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      isSpeaking = false;
    };
  });

  $effect(() => {
    if (typeof window === 'undefined') return;
    const currentId = article.id;
    const currentContent = articleContent || article.content || '';
    void cacheReaderState(
      {
        read,
        saved,
        hidden,
        thumbsUp: liked,
        thumbsDown: disliked,
      },
      currentId,
    );
    void currentContent;
  });

  function adjustFontScale(delta: number) {
    fontScale = Math.max(
      0.9,
      Math.min(1.25, Number((fontScale + delta).toFixed(2))),
    );
    try {
      localStorage.setItem('feed-me-maybe:reader-scale', String(fontScale));
    } catch {
      // Reader controls remain useful when storage is unavailable.
    }
  }

  async function shareArticle() {
    await shareArticleLink(article, 'Article link copied');
  }

  function speakArticle() {
    if (!('speechSynthesis' in window)) {
      addToast('Text-to-speech is not available in this browser', 'info');
      return;
    }

    if (isSpeaking) {
      window.speechSynthesis.cancel();
      isSpeaking = false;
      return;
    }

    const rawReadable = stripPlainText(
      activeBodyContent || articleContent || article.summary,
    );
    const text = rawReadable
      ? articleContentEl?.textContent?.trim() || rawReadable
      : '';
    if (!text) {
      addToast('There is no readable text for this article', 'info');
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.96;
    utterance.onend = () => (isSpeaking = false);
    utterance.onerror = () => (isSpeaking = false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    isSpeaking = true;
  }

  // Prevent main scroll when in iframe/proxy mode
  $effect(() => {
    if (isEmbeddedMode) {
      const main = document.querySelector<HTMLElement>('#main-content, main');
      if (main) main.style.overflow = 'hidden';
      return () => {
        if (main) main.style.overflow = '';
      };
    }
  });

  $effect(() => {
    if (!lightboxOpen) return;

    requestAnimationFrame(() => lightboxBackdropEl?.focus());

    return () => {
      lightboxPreviouslyFocused?.focus?.();
      lightboxPreviouslyFocused = null;
    };
  });

  $effect(() => {
    const content = articleContentEl;
    const images = articleImages;
    // Rebuild controls when Svelte replaces the rendered article HTML.
    if (!content || !renderedArticleContent) return;

    const buttons = [...content.querySelectorAll('img')].flatMap((image) => {
      if (image.closest('a, button')) return [];
      const source = image.getAttribute('src');
      if (!source) return [];
      let absoluteSource: string;
      try {
        absoluteSource = new URL(source, article.url).href;
      } catch {
        return [];
      }
      const index = images.findIndex((item) => item.src === absoluteSource);
      if (index < 0) return [];

      const button = document.createElement('button');
      button.type = 'button';
      button.className =
        'block max-w-full cursor-zoom-in focus-visible:outline-2 focus-visible:outline-primary-400';
      button.setAttribute(
        'aria-label',
        image.alt
          ? `Enlarge image: ${image.alt}`
          : `Enlarge article image ${index + 1}`,
      );
      button.onclick = () => openLightbox(index, button);
      image.replaceWith(button);
      button.append(image);
      return [button];
    });
    return () => {
      for (const button of buttons) button.replaceWith(...button.childNodes);
    };
  });

  function escapeCssIdent(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function syncActiveHeading(
    mainEl?: HTMLElement | null,
    headings: readonly ReaderHeading[] = outlineHeadings,
  ): void {
    if (!isReaderMode || headings.length < 2 || !articleContentEl) {
      activeHeadingId = '';
      return;
    }
    const main =
      mainEl ?? document.querySelector<HTMLElement>('#main-content, main');
    const threshold = (main?.getBoundingClientRect().top ?? 0) + 96;
    let current = headings[0]?.id ?? '';
    for (const heading of headings) {
      const el = articleContentEl.querySelector<HTMLElement>(
        `#${escapeCssIdent(heading.id)}`,
      );
      if (!el) continue;
      if (el.getBoundingClientRect().top <= threshold) {
        current = heading.id;
      } else {
        break;
      }
    }
    activeHeadingId = current;
  }

  function scrollToReaderAnchor(rawId: string): boolean {
    if (typeof document === 'undefined' || !readerArticleEl) return false;
    const normalizedId = normalizeUserContentId(rawId);
    if (!normalizedId) return false;

    const targetEl = readerArticleEl.querySelector<HTMLElement>(
      `#${escapeCssIdent(normalizedId)}`,
    );
    if (!targetEl) return false;

    let ancestor = targetEl.parentElement;
    while (ancestor && ancestor !== readerArticleEl) {
      if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
        ancestor.open = true;
      }
      ancestor = ancestor.parentElement;
    }

    const main = document.querySelector<HTMLElement>('#main-content, main');
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    const behavior: ScrollBehavior = prefersReducedMotion ? 'auto' : 'smooth';

    if (main) {
      const mainRect = main.getBoundingClientRect();
      const targetRect = targetEl.getBoundingClientRect();
      const scrollMarginTop =
        Number.parseFloat(getComputedStyle(targetEl).scrollMarginTop) || 40;
      const nextTop = Math.max(
        0,
        main.scrollTop + (targetRect.top - mainRect.top) - scrollMarginTop,
      );
      main.scrollTo({ top: nextTop, behavior });
    } else {
      targetEl.scrollIntoView({ behavior, block: 'start' });
    }

    if (outlineHeadings.some((heading) => heading.id === normalizedId)) {
      activeHeadingId = normalizedId;
    }

    if (!targetEl.hasAttribute('tabindex')) {
      targetEl.setAttribute('tabindex', '-1');
    }
    targetEl.focus({ preventScroll: true });
    return true;
  }

  function handleOutlineLinkClick(event: MouseEvent, headingId: string): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    scrollToReaderAnchor(headingId);
  }

  $effect(() => {
    const content = articleContentEl;
    const rendered = renderedArticleContent;
    const summaryFallback = !activeBodyContent ? article.summary : null;
    const readerActive = isReaderMode;
    void rendered;
    void summaryFallback;

    if (!readerActive || !content) {
      outlineHeadings = [];
      activeHeadingId = '';
      return;
    }

    const headings = extractArticleHeadings(content);
    outlineHeadings = headings;
    syncActiveHeading(null, headings);
  });

  $effect(() => {
    const container = readerArticleEl;
    if (!container) return;

    const onReaderClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest('a');
      if (!anchor) return;
      const rawHref = anchor.getAttribute('href')?.trim();
      if (!rawHref || !rawHref.startsWith('#')) return;

      event.preventDefault();
      const normalizedHref = normalizeFragmentHref(rawHref);
      if (!normalizedHref) return;
      scrollToReaderAnchor(normalizedHref.slice(1));
    };

    container.addEventListener('click', onReaderClick);
    return () => {
      container.removeEventListener('click', onReaderClick);
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
    const sourceContent = activeBodyContent;
    if (!sourceContent) return null;

    const imgTagMatch = sourceContent.match(/<img\b[^>]*>/i);
    if (imgTagMatch) {
      const tag = imgTagMatch[0];
      const srcAttr = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
      const lazyAttr = tag.match(
        /\bdata-(?:src|lazy-src|original)=["']([^"']+)["']/i,
      )?.[1];
      const candidate =
        srcAttr && !/^(?:data:|blob:|about:)/i.test(srcAttr.trim())
          ? srcAttr
          : lazyAttr || srcAttr;
      if (candidate) return candidate;
    }

    const markdownMatch = sourceContent.match(
      /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
    );
    return markdownMatch ? markdownMatch[1] : null;
  }

  function shouldShowHero(): boolean {
    if (!article.image_url || heroImageBroken) return false;
    const firstImg = contentFirstImg();
    if (!firstImg) return true;

    // Normalize against article.url so relative first-image paths deduplicate properly
    try {
      const heroUrl = new URL(article.image_url, article.url);
      const firstUrl = new URL(firstImg, article.url);
      return heroUrl.pathname !== firstUrl.pathname;
    } catch {
      return article.image_url !== firstImg;
    }
  }

  function openLightbox(index: number, trigger: HTMLElement) {
    if (!articleImages.length) return;
    lightboxIndex = Math.max(0, Math.min(index, articleImages.length - 1));
    lightboxPreviouslyFocused = trigger;
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

  function handleLightboxKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented) return;

    if (lightboxOpen) {
      if (event.key === 'Tab' && lightboxBackdropEl) {
        const focusableElements = Array.from(
          lightboxBackdropEl.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => element.getClientRects().length > 0);

        if (focusableElements.length === 0) {
          event.preventDefault();
          lightboxBackdropEl.focus();
          return;
        }

        const first = focusableElements[0];
        const last = focusableElements[focusableElements.length - 1];
        const activeElement = document.activeElement;

        if (!lightboxBackdropEl.contains(activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (
          event.shiftKey &&
          (activeElement === first || activeElement === lightboxBackdropEl)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeLightbox();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goToLightboxImage(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        goToLightboxImage(1);
      }
      return;
    }

    const openMenu = document.querySelector<HTMLDetailsElement>(
      '[data-reader-more][open]',
    );
    if (event.key === 'Escape' && openMenu) {
      event.preventDefault();
      openMenu.open = false;
      readerMoreOpen = false;
      return;
    }

    const hasOpenModal = Boolean(
      document.querySelector('dialog[open], [aria-modal="true"]'),
    );
    if (
      shouldToggleReaderOutline(event, {
        singleKeyShortcutsEnabled: getSingleKeyShortcutsEnabled(),
        lightboxOpen,
        isReaderMode,
        headingCount: outlineHeadings.length,
        hasOpenModal,
      })
    ) {
      event.preventDefault();
      outlineOpen = !outlineOpen;
      return;
    }

    if (!canTriggerSingleKeyShortcut(event)) return;

    const key = event.key.toLowerCase();
    if (key === 'u' || (event.key === 'Escape' && !event.shiftKey)) {
      event.preventDefault();
      void goto(returnPath, { replaceState: true });
      return;
    }
    const destination = key === 'j' ? nextId : key === 'k' ? previousId : null;
    if (destination) {
      event.preventDefault();
      void goto(readerHref(destination), { replaceState: true });
      return;
    }
    if (key === 'o') {
      event.preventDefault();
      window.open(sourceHref, '_blank', 'noopener,noreferrer');
      return;
    }
    if (key === 'v') {
      event.preventDefault();
      window.open(article.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (key === 'd') {
      event.preventDefault();
      if (!isEmbeddedMode) void loadFullText();
      return;
    }
    if (key === 'h' || key === 's' || key === 'm') {
      event.preventDefault();
      if (key === 'm') void toggleRead();
      else void interact(key === 'h' ? 'hide' : 'save');
      return;
    }
    if ((key === 'l' || key === 'x') && !reactionsLocked) {
      event.preventDefault();
      void interact(key === 'l' ? 'thumbs_up' : 'thumbs_down');
    }
  }

  function handleReaderWindowPointerDown(event: PointerEvent): void {
    const target = event.target as Element | null;
    if (target?.closest('[data-reader-more]')) return;
    readerMoreOpen = false;
  }

  async function interact(type: InteractionType) {
    if (pendingAction) return;

    const targetArticleId = article.id;
    const visibleArticleIds =
      type === 'thumbs_up' ||
      type === 'thumbs_down' ||
      type === 'save' ||
      type === 'hide'
        ? [targetArticleId]
        : undefined;

    // Optimistic UI updates
    const prevLiked = liked;
    const prevDisliked = disliked;
    const prevSaved = saved;
    const prevHidden = hidden;
    const prevExplicitlyHidden = explicitlyHidden;
    const prevRead = read;
    pendingAction = type;

    const restoring =
      type === 'hide' && (prevHidden || prevExplicitlyHidden || prevDisliked);
    const restoringRejection = restoring && prevDisliked;
    const shouldHide =
      (!restoring && type === 'hide') || type === 'thumbs_down';

    if (type === 'thumbs_up') {
      liked = !liked;
      if (liked) {
        disliked = false;
        hidden = false;
        explicitlyHidden = false;
      }
    } else if (type === 'thumbs_down') {
      disliked = true;
      liked = false;
      hidden = true;
    } else if (type === 'save') {
      saved = !saved;
    } else if (restoring) {
      hidden = false;
      explicitlyHidden = false;
      if (restoringRejection) disliked = false;
    } else if (shouldHide) {
      hidden = true;
      if (type === 'hide') explicitlyHidden = true;
    }

    if (shouldHide) {
      markQueueArticleDismissed(targetArticleId, true);
    } else if (restoring || (type === 'thumbs_up' && !prevLiked)) {
      markQueueArticleDismissed(targetArticleId, false);
    }

    try {
      const actualType: TriageAction =
        type === 'save' && prevSaved
          ? 'unsave'
          : type === 'thumbs_up' && prevLiked
            ? 'unthumbs_up'
            : type === 'thumbs_up' && (prevHidden || prevDisliked)
              ? 'boost'
              : type === 'hide' && restoring
                ? restoringRejection
                  ? 'restore'
                  : 'unhide'
                : type;

      const result = await executeArticleTriage({
        articleId: targetArticleId,
        action: actualType,
        scope: offlineScope(),
        visibleArticleIds,
        onUndo: () => {
          if (article.id === targetArticleId) {
            liked = prevLiked;
            disliked = prevDisliked;
            saved = prevSaved;
            hidden = prevHidden;
            explicitlyHidden = prevExplicitlyHidden;
            read = prevRead;
          }
          markQueueArticleDismissed(
            targetArticleId,
            prevHidden || prevDisliked,
          );
          void cacheReaderState(
            {
              read: prevRead,
              saved: prevSaved,
              hidden: prevHidden,
              thumbsUp: prevLiked,
              thumbsDown: prevDisliked,
            },
            targetArticleId,
          );
        },
      });

      if (result.mode === 'online' && article.id === targetArticleId) {
        const after = result.after;
        const state = after
          ? {
              read: after.read,
              saved: after.saved,
              hidden: after.hidden,
              thumbsUp: after.thumbsUp,
              thumbsDown: after.thumbsDown,
            }
          : {
              read,
              saved,
              hidden,
              thumbsUp: liked,
              thumbsDown: disliked,
            };
        read = state.read;
        if (after) {
          saved = state.saved;
          hidden = state.hidden;
          liked = state.thumbsUp;
          disliked = state.thumbsDown;
        }
        if (actualType === 'hide') explicitlyHidden = true;
        else if (
          actualType === 'restore' ||
          actualType === 'unhide' ||
          actualType === 'boost'
        ) {
          explicitlyHidden = false;
        }
        void cacheReaderState(state, targetArticleId);
      }
    } catch {
      // Revert on failure
      if (article.id === targetArticleId) {
        liked = prevLiked;
        disliked = prevDisliked;
        saved = prevSaved;
        hidden = prevHidden;
        explicitlyHidden = prevExplicitlyHidden;
        read = prevRead;
      }
      markQueueArticleDismissed(targetArticleId, prevHidden || prevDisliked);
      addToast('Action failed', 'error');
    } finally {
      pendingAction = null;
    }
  }

  function readerHref(id: string) {
    return `/articles/${encodeURIComponent(id)}?mode=${encodeURIComponent(mode)}`;
  }

  async function toggleRead() {
    if (pendingAction) return;
    const targetArticleId = article.id;
    const prevRead = read;
    const nextAction: TriageAction = prevRead ? 'unread' : 'read';
    pendingAction = nextAction;
    read = !prevRead;
    try {
      const result = await executeArticleTriage({
        articleId: targetArticleId,
        action: nextAction,
        scope: offlineScope(),
        onUndo: () => {
          if (article.id === targetArticleId) {
            read = prevRead;
          }
          void cacheReaderState(
            {
              read: prevRead,
              saved,
              hidden,
              thumbsUp: liked,
              thumbsDown: disliked,
            },
            targetArticleId,
          );
        },
      });
      if (
        result.mode === 'online' &&
        result.after &&
        article.id === targetArticleId
      ) {
        read = result.after.read;
      }
    } catch {
      if (article.id === targetArticleId) {
        read = prevRead;
      }
      addToast(
        prevRead
          ? 'Could not mark article as unread'
          : 'Could not mark article as read',
        'error',
      );
    } finally {
      pendingAction = null;
    }
  }

  async function loadFullText() {
    if (fetchingContent) return;
    if (fetchedContent || fullTextConfirmed) {
      showSummaryInstead = false;
      addToast('Full article text is already loaded', 'info');
      return;
    }
    const requestedId = article.id;
    loadFullTextController?.abort();
    const controller = new AbortController();
    loadFullTextController = controller;
    fetchingContent = true;
    fetchContentError = '';
    try {
      const response = await fetchWithCsrf(
        `/api/articles/${encodeURIComponent(requestedId)}/content`,
        { method: 'POST', signal: controller.signal },
      );
      const result = (await response.json()) as {
        content?: string;
        error?: string;
        alreadyFullText?: boolean;
      };
      if (controller.signal.aborted || article.id !== requestedId) return;
      if (!response.ok) {
        if (
          response.status === 422 &&
          (result.alreadyFullText ||
            result.error?.includes('more text than is already available'))
        ) {
          fullTextConfirmed = true;
          fetchContentError = '';
          addToast('Full article text is already loaded', 'info');
          return;
        }
        throw new Error(result.error);
      }
      if (result.content) {
        fetchedContent = result.content;
        fullTextConfirmed = true;
        showSummaryInstead = false;
        void cacheReaderState(
          {
            read,
            saved,
            hidden,
            thumbsUp: liked,
            thumbsDown: disliked,
          },
          requestedId,
        );
      }
    } catch (error) {
      if (controller.signal.aborted || article.id !== requestedId) return;
      fetchContentError =
        error instanceof Error && error.message
          ? error.message
          : 'Could not load full article text.';
    } finally {
      if (loadFullTextController === controller) {
        loadFullTextController = null;
      }
      if (article.id === requestedId) {
        fetchingContent = false;
      }
    }
  }

  const iframeUrl = $derived(
    mode === 'proxy'
      ? `/api/proxy?url=${encodeURIComponent(article.url)}`
      : article.url,
  );

  let touchStartX: number | null = null;
  let touchStartY: number | null = null;
  let swipeOffsetX = $state(0);
  const SWIPE_ACTION_THRESHOLD = 88;
  const SWIPE_LONG_LEFT_THRESHOLD = 168;
  const SWIPE_MAX_VERTICAL_DRIFT = 72;
  const SWIPE_EXCLUDED_SELECTOR =
    'a, button, summary, details, input, select, textarea, table, pre, code, img, picture, figure, header, nav, .reader-action-bar, [data-reader-more], [role="dialog"], [aria-modal="true"], [contenteditable="true"], [data-no-reader-swipe]';

  const swipeHintLabel = $derived.by(() => {
    if (swipeOffsetX > SWIPE_ACTION_THRESHOLD) {
      return saved ? 'Release to Unsave' : 'Release to Save';
    }
    if (swipeOffsetX < -SWIPE_LONG_LEFT_THRESHOLD) {
      return 'Release to Dislike & Hide';
    }
    if (swipeOffsetX < -SWIPE_ACTION_THRESHOLD) {
      return canRestore ? 'Release to Restore' : 'Release to Hide';
    }
    return '';
  });

  function isSwipeExcluded(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      Boolean(target.closest(SWIPE_EXCLUDED_SELECTOR))
    );
  }

  function resetSwipeState() {
    touchStartX = null;
    touchStartY = null;
    swipeOffsetX = 0;
  }

  function handlePointerDown(e: PointerEvent) {
    if (
      isEmbeddedMode ||
      lightboxOpen ||
      readerMoreOpen ||
      e.pointerType === 'mouse' ||
      !e.isPrimary ||
      isSwipeExcluded(e.target)
    )
      return;
    touchStartX = e.clientX;
    touchStartY = e.clientY;
    swipeOffsetX = 0;
  }

  function handlePointerMove(e: PointerEvent) {
    if (!e.isPrimary || touchStartX === null || touchStartY === null) return;
    const dx = e.clientX - touchStartX;
    const dy = e.clientY - touchStartY;
    if (
      Math.abs(dy) > SWIPE_MAX_VERTICAL_DRIFT ||
      Math.abs(dy) > Math.abs(dx)
    ) {
      swipeOffsetX = 0;
      return;
    }
    if (Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 2) {
      swipeOffsetX = Math.max(-220, Math.min(220, Math.round(dx)));
    } else {
      swipeOffsetX = 0;
    }
  }

  function handlePointerUp(e: PointerEvent) {
    if (!e.isPrimary || touchStartX === null || touchStartY === null) return;
    const dx = e.clientX - touchStartX;
    const dy = e.clientY - touchStartY;
    resetSwipeState();

    if (isSwipeExcluded(e.target)) return;
    if (
      Math.abs(dy) <= SWIPE_MAX_VERTICAL_DRIFT &&
      Math.abs(dx) > Math.abs(dy) * 2
    ) {
      if (dx < -SWIPE_LONG_LEFT_THRESHOLD) void interact('thumbs_down');
      else if (dx < -SWIPE_ACTION_THRESHOLD) void interact('hide');
      else if (dx > SWIPE_ACTION_THRESHOLD) void interact('save');
    }
  }
</script>

<svelte:head>
  <title>{article.title} · Feed Me Maybe</title>
</svelte:head>

<svelte:window
  onkeydown={handleLightboxKeydown}
  onpointerdown={handleReaderWindowPointerDown}
/>

<div
  class={isEmbeddedMode
    ? 'absolute inset-0 z-0 bg-surface-950'
    : 'mx-auto max-w-4xl'}
>
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
            <p class="max-w-xs text-center text-xs text-surface-300">
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
      class="glass-card glass-card-hover relative overflow-x-clip"
      style:touch-action="pan-y pinch-zoom"
      onpointerdown={handlePointerDown}
      onpointermove={handlePointerMove}
      onpointerup={handlePointerUp}
      onpointercancel={resetSwipeState}
    >
      {#if swipeHintLabel}
        <div
          class="pointer-events-none sticky top-3 z-30 mx-4 mt-3 flex justify-center"
          aria-live="polite"
        >
          <span
            class="rounded-full border px-3 py-1 text-xs font-semibold shadow-lg backdrop-blur-md"
            style="background: color-mix(in oklch, var(--color-surface-900) 90%, transparent); border-color: color-mix(in oklch, var(--color-primary-400) 40%, transparent); color: var(--color-surface-100);"
          >
            {swipeHintLabel}
          </span>
        </div>
      {/if}

      <div class="flex flex-wrap items-center gap-2 px-4 pt-4">
        <button
          type="button"
          class="btn preset-tonal"
          onclick={loadFullText}
          disabled={fetchingContent ||
            Boolean(fetchedContent) ||
            fullTextConfirmed}
        >
          {fetchingContent
            ? 'Fetching full text…'
            : fetchedContent || fullTextConfirmed
              ? 'Full text loaded'
              : 'Fetch full text'}
        </button>
        {#if canToggleSummaryAndFullText}
          <button
            type="button"
            class="btn btn-sm preset-outlined"
            onclick={() => (showSummaryInstead = !showSummaryInstead)}
          >
            {showSummaryInstead ? 'Show full text' : 'Show feed summary'}
          </button>
        {/if}
        {#if fetchContentError}
          <p role="alert" class="w-full text-sm text-error-300">
            {fetchContentError}
          </p>
        {/if}
        {#if mode === 'archive' && pageData.archiveFailed}
          <p
            role="status"
            class="w-full rounded-sm border px-3 py-2 text-xs"
            style="color: var(--color-warning-300, var(--color-surface-200)); border-color: color-mix(in oklch, var(--color-surface-100) 18%, transparent); background: color-mix(in oklch, var(--color-surface-800) 40%, transparent);"
          >
            Archived snapshot was unavailable or shorter than stored text;
            showing saved feed content instead.
          </p>
        {/if}
      </div>

      {#if shouldShowHero()}
        <button
          type="button"
          class="group relative mt-3 block w-full overflow-hidden text-left"
          onclick={(event) => openLightbox(0, event.currentTarget)}
          aria-label="Open article image"
        >
          <img
            src={article.image_url}
            alt={articleImages[0]?.alt || `Illustration for ${article.title}`}
            class="h-64 w-full object-cover transition-transform duration-300 group-hover:scale-[1.01] md:h-80 cursor-zoom-in"
            decoding="async"
            fetchpriority="high"
            onerror={() => (heroImageBroken = true)}
          />
          <div
            class="pointer-events-none absolute inset-0 bg-gradient-to-t from-[var(--color-surface-950)] via-transparent to-transparent opacity-80"
          ></div>
        </button>
      {/if}

      <div
        bind:this={readerArticleEl}
        class="p-5 pb-28 md:p-8 md:pb-32"
        style="--reader-font-scale: {fontScale};"
      >
        <div class="mb-6">
          <div
            class="flex flex-wrap items-center gap-2 text-xs"
            style="color: var(--color-surface-300);"
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
            class="mt-3 font-bold leading-tight"
            style="color: var(--color-surface-50); text-shadow: 0 2px 4px rgba(0,0,0,0.3); font-size: clamp({(
              1.5 * fontScale
            ).toFixed(3)}rem, 2.5vw, {(1.875 * fontScale).toFixed(3)}rem);"
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
              class="prose prose-sm prose-glass max-w-none leading-relaxed"
              style="color: color-mix(in oklch, var(--color-surface-100) 75%, transparent); font-size: {(
                fontScale * 0.875
              ).toFixed(3)}rem;"
            >
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html formatContent(article.ai_summary, article.url)}
            </div>
          </div>
        {/if}

        {#if hasOutline}
          <nav
            aria-label="Table of contents"
            data-no-reader-swipe
            class="mb-6 border"
            style="background: color-mix(in oklch, var(--color-surface-900) 65%, transparent); border-color: color-mix(in oklch, var(--color-surface-100) 12%, transparent); border-radius: 2px;"
          >
            <button
              type="button"
              class="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-xs font-semibold tracking-wide transition-colors hover:bg-white/[0.03]"
              style="color: var(--color-surface-200);"
              aria-expanded={outlineOpen}
              aria-controls="reader-outline-list"
              onclick={() => (outlineOpen = !outlineOpen)}
            >
              <span class="flex items-center gap-2">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                  style="color: var(--color-primary-400);"
                >
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" />
                  <line x1="3" y1="12" x2="3.01" y2="12" />
                  <line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
                <span>Table of contents</span>
                <span
                  class="rounded px-1.5 py-0.5 text-[11px] font-medium"
                  style="background: color-mix(in oklch, var(--color-surface-100) 8%, transparent); color: var(--color-surface-300);"
                >
                  {outlineHeadings.length}
                </span>
              </span>
              <span class="flex items-center gap-2">
                <kbd
                  class="hidden rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[11px] font-normal text-surface-300 sm:inline-block"
                  title="Press [ to toggle table of contents">[</kbd
                >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                  class="transition-transform duration-150 {outlineOpen
                    ? 'rotate-180'
                    : ''}"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </span>
            </button>

            {#if outlineOpen}
              <ol
                id="reader-outline-list"
                class="max-h-60 overflow-y-auto border-t px-2 py-2 text-sm"
                style="border-color: color-mix(in oklch, var(--color-surface-100) 10%, transparent);"
              >
                {#each outlineHeadings as heading (heading.id)}
                  {@const isActive = activeHeadingId === heading.id}
                  {@const depth = Math.max(
                    0,
                    heading.level - minOutlineHeadingLevel,
                  )}
                  <li>
                    <a
                      href={`#${heading.id}`}
                      onclick={(event) =>
                        handleOutlineLinkClick(event, heading.id)}
                      aria-current={isActive ? 'location' : undefined}
                      class="block truncate rounded-sm border-l-2 py-1 pr-2.5 text-[13px] leading-snug no-underline transition-colors hover:bg-white/[0.04]"
                      style="padding-left: {(0.625 + depth * 0.875).toFixed(
                        3,
                      )}rem; border-color: {isActive
                        ? 'var(--color-primary-400)'
                        : 'transparent'}; color: {isActive
                        ? 'var(--color-primary-300)'
                        : 'var(--color-surface-200)'}; background: {isActive
                        ? 'color-mix(in oklch, var(--color-primary-500) 8%, transparent)'
                        : 'transparent'};"
                    >
                      {heading.text}
                    </a>
                  </li>
                {/each}
              </ol>
            {/if}
          </nav>
        {/if}

        <div
          class="prose prose-glass max-w-none min-w-0 overflow-x-auto break-words [&_img]:cursor-zoom-in"
          bind:this={articleContentEl}
          style="font-size: {(fontScale * 1.125).toFixed(3)}rem;"
        >
          {#if activeBodyContent}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html renderedArticleContent}
          {:else if article.summary}
            <div class="leading-relaxed">
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html formatContent(article.summary, article.url)}
            </div>
          {:else}
            <p class="italic" style="color: var(--color-surface-300);">
              No content available.
            </p>
          {/if}
        </div>

        {#if isRedditPost}
          {#key article.id}
            <RedditComments
              permalink={article.url}
              useProxy={Boolean(article.feed_use_proxy)}
              proxyBaseUrl={pageData.proxyBaseUrl}
            />
          {/key}
        {/if}
      </div>
    </article>
  {/if}

  {#if lightboxOpen && activeLightboxImage}
    <div
      class="fixed inset-0 z-[70] overscroll-contain bg-black/95"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="Article image viewer"
      data-no-reader-swipe
      in:fade={{ duration: 160 }}
      bind:this={lightboxBackdropEl}
    >
      <div class="flex h-full w-full flex-col">
        <div
          class="flex items-center justify-between gap-3 px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:p-4"
        >
          <div class="text-xs font-medium text-white/70" role="status">
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

        <div
          class="flex min-h-0 flex-1 items-center justify-center px-3 pb-3 md:px-6 md:pb-6"
        >
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

          <div
            class="flex h-full w-full min-h-0 min-w-0 items-center justify-center"
          >
            <img
              src={activeLightboxImage.src}
              alt={activeLightboxImage.alt ||
                (activeLightboxImage.source === 'hero'
                  ? `Illustration for ${article.title}`
                  : `Article image ${lightboxIndex + 1}`)}
              class="max-h-full max-w-full select-none object-contain"
              draggable="false"
              decoding="async"
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
          <div
            class="border-t border-white/10 bg-black/65 px-3 py-3 backdrop-blur-md md:px-6"
          >
            <div class="flex gap-2 overflow-x-auto pb-1">
              {#each articleImages as image, index (image.src)}
                <button
                  type="button"
                  class="relative h-16 w-24 flex-none overflow-hidden rounded-sm border transition md:h-20 md:w-28 {index ===
                  lightboxIndex
                    ? 'border-primary-400 ring-1 ring-primary-400'
                    : 'border-white/10 opacity-70 hover:opacity-100'}"
                  onclick={() => (lightboxIndex = index)}
                  aria-label={`Show image ${index + 1}`}
                  aria-pressed={index === lightboxIndex}
                >
                  <img
                    src={image.src}
                    alt=""
                    class="h-full w-full object-cover"
                    draggable="false"
                    loading="lazy"
                    decoding="async"
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
  {#if isReaderMode}
    <div
      class="pointer-events-none fixed left-0 right-0 top-0 z-[60] h-1 bg-surface-950/40"
      aria-hidden="true"
    >
      <div
        class="h-full bg-gradient-to-r from-primary-400 via-secondary-400 to-primary-400 transition-[width] duration-150"
        style="width: {readingProgress}%;"
      ></div>
    </div>
  {/if}

  <div
    class="reader-action-bar fixed bottom-[calc(var(--fmm-mobile-nav-height)+env(safe-area-inset-bottom))] left-0 right-0 z-50 flex flex-wrap items-center justify-center gap-1.5 rounded-t-sm border p-1.5 shadow-2xl backdrop-blur-xl md:bottom-6 md:left-1/2 md:right-auto md:max-w-[calc(100vw-2rem)] md:-translate-x-1/2 md:rounded-sm"
    role="group"
    aria-label="Article reader actions"
    data-no-reader-swipe
    style="background: color-mix(in oklch, var(--color-surface-900) 80%, transparent); border-color: color-mix(in oklch, var(--color-surface-100) 15%, transparent);"
    in:fly={{ y: 20, duration: 400, delay: 400 }}
  >
    <a
      href={returnPath}
      data-sveltekit-replacestate
      class="action-btn h-9 px-3 rounded-full"
      aria-label="Back to article list"
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
    </a>

    {#if previousId}
      <a
        class="action-btn h-9 px-3 rounded-full"
        href={readerHref(previousId)}
        data-sveltekit-replacestate
        aria-label="Previous article"
        title="Previous article (k)">←</a
      >
    {/if}
    {#if nextId}
      <a
        class="action-btn h-9 px-3 rounded-full"
        href={readerHref(nextId)}
        data-sveltekit-replacestate
        aria-label="Next article"
        title="Next article (j)">→</a
      >
    {/if}

    <div class="w-px h-6 bg-surface-100/10 mx-1"></div>

    <button
      type="button"
      class="action-btn min-h-11 px-3 rounded-full !inline-flex {saved
        ? '!text-success-400 !bg-success-500/10 !border-success-500/30'
        : ''}"
      disabled={Boolean(pendingAction)}
      onclick={() => interact('save')}
      aria-pressed={saved}
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
        aria-hidden="true"
        ><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" /></svg
      >
      <span class="ml-1.5">{saved ? 'Saved' : 'Save'}</span>
    </button>

    <button
      type="button"
      class="action-btn min-h-11 px-3 rounded-full !inline-flex {!read
        ? '!text-primary-300 !bg-primary-500/10 !border-primary-500/30'
        : ''}"
      disabled={Boolean(pendingAction)}
      onclick={() => void toggleRead()}
      aria-label={read ? 'Mark as unread' : 'Mark as read'}
      aria-pressed={!read}
      title={read ? 'Mark as unread (m)' : 'Mark as read (m)'}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg
      >
      <span class="ml-1.5 hidden sm:inline"
        >{read ? 'Mark as unread' : 'Mark as read'}</span
      >
    </button>

    {#if isReaderMode && isSpeaking}
      <button
        type="button"
        class="action-btn min-h-11 px-3 rounded-full !inline-flex !text-primary-300 !bg-primary-500/15 !border-primary-500/30"
        onclick={speakArticle}
        aria-label="Stop reading aloud"
        title="Stop reading aloud"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          ><rect x="6" y="6" width="12" height="12" rx="2" /></svg
        >
        <span class="ml-1.5">Stop</span>
      </button>
    {/if}

    {#if isReaderMode}
      <button
        type="button"
        class="action-btn min-h-11 px-3 rounded-full"
        onclick={() => void shareArticle()}
        title="Share article"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
          ><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle
            cx="18"
            cy="19"
            r="3"
          /><path d="m8.6 13.5 6.8 4" /><path d="m15.4 6.5-6.8 4" /></svg
        >
        <span class="ml-1.5">Share</span>
      </button>
    {/if}

    <details class="static" data-reader-more bind:open={readerMoreOpen}>
      <summary
        class="action-btn flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-full px-3"
        aria-label="More reader actions"
        aria-controls="reader-more-actions"
        aria-expanded={readerMoreOpen}
        title="More reader actions"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="5" cy="12" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="19" cy="12" r="1.5" />
        </svg>
        <span class="hidden sm:inline">More</span>
      </summary>

      <div
        id="reader-more-actions"
        class="absolute bottom-full left-1/2 z-40 mb-2 flex w-[min(24rem,calc(100vw-1rem))] -translate-x-1/2 flex-col items-stretch justify-start gap-1 overflow-y-auto overscroll-contain rounded-sm border p-2 shadow-2xl backdrop-blur-xl"
        role="group"
        aria-label="Additional reader controls"
        style="max-height: max(5rem, min(28rem, calc(100dvh - 13rem))); background: color-mix(in oklch, var(--color-surface-900) 94%, transparent); border-color: color-mix(in oklch, var(--color-surface-100) 15%, transparent);"
      >
        <div
          class="flex items-center gap-1 border-r pr-1.5 mr-0.5"
          style="border-color: color-mix(in oklch, var(--color-surface-100) 10%, transparent);"
        >
          <button
            type="button"
            class="action-btn min-h-11 flex-1 rounded-full px-3 {liked
              ? '!text-primary-400 !bg-primary-500/10 !border-primary-500/30'
              : ''}"
            disabled={Boolean(pendingAction) || reactionsLocked}
            onclick={() => interact('thumbs_up')}
            aria-label={liked ? 'Remove like' : 'Like article'}
            aria-pressed={liked}
            title={liked ? 'Remove like' : 'Like'}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill={liked ? 'currentColor' : 'none'}
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
              ><path d="M7 10v12" /><path
                d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"
              /></svg
            >
            <span class="ml-1.5">{liked ? 'Liked' : 'Like'}</span>
          </button>
          <button
            type="button"
            class="action-btn min-h-11 flex-1 rounded-full px-3 {disliked
              ? '!text-error-400 !bg-error-500/10 !border-error-500/30'
              : ''}"
            disabled={Boolean(pendingAction) || reactionsLocked}
            onclick={() => interact('thumbs_down')}
            aria-label="Dislike and hide article"
            aria-pressed={disliked}
            title="Dislike and hide"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill={disliked ? 'currentColor' : 'none'}
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
              ><path d="M17 14V2" /><path
                d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z"
              /></svg
            >
            <span class="ml-1.5">{disliked ? 'Disliked' : 'Dislike'}</span>
          </button>
        </div>

        {#if isReaderMode}
          <div class="flex items-center gap-1 border-r border-white/10 pr-1.5">
            <button
              type="button"
              class="action-btn min-h-11 flex-1 rounded-full px-3"
              onclick={() => adjustFontScale(-0.05)}
              aria-label="Decrease text size"
              title="Decrease text size">A−</button
            >
            <button
              type="button"
              class="action-btn min-h-11 flex-1 rounded-full px-3"
              onclick={() => adjustFontScale(0.05)}
              aria-label="Increase text size"
              title="Increase text size">A+</button
            >
          </div>

          <button
            type="button"
            class="action-btn min-h-11 px-3 rounded-full"
            onclick={speakArticle}
            aria-pressed={isSpeaking}
            aria-label={isSpeaking
              ? 'Stop reading aloud'
              : 'Read article aloud'}
            title={isSpeaking ? 'Stop reading aloud' : 'Read article aloud'}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              ><path d="M11 5 6 9H2v6h4l5 4z" /><path
                d="M19.07 4.93a10 10 0 0 1 0 14.14"
              /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /></svg
            >
            <span class="ml-1.5">{isSpeaking ? 'Stop' : 'Listen'}</span>
          </button>
        {/if}

        <a
          href={sourceHref}
          target="_blank"
          rel="noopener noreferrer"
          class="action-btn min-h-11 px-3 rounded-full no-underline hover:!text-primary-300"
          aria-label={mode === 'archive'
            ? 'Open archived source'
            : 'Open original source'}
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
            aria-hidden="true"
            ><path
              d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
            /><polyline points="15 3 21 3 21 9" /><line
              x1="10"
              y1="14"
              x2="21"
              y2="3"
            /></svg
          >
          <span class="ml-1.5">Source</span>
        </a>

        <button
          type="button"
          class="action-btn min-h-11 px-3 rounded-full !inline-flex {canRestore
            ? '!text-success-400 hover:!text-success-300'
            : 'hover:!text-error-400'}"
          disabled={Boolean(pendingAction)}
          onclick={() => interact('hide')}
          aria-label={canRestore ? 'Restore article' : 'Hide article'}
          aria-pressed={explicitlyHidden}
          title={canRestore ? 'Restore Article' : 'Hide Article'}
        >
          {#if canRestore}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          {:else}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
              ><path d="M3 6h18" /><path
                d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"
              /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></svg
            >
          {/if}
          <span class="ml-1.5">{canRestore ? 'Restore' : 'Hide'}</span>
        </button>
      </div>
    </details>
  </div>
</div>

<style>
  :global(#main-content:has(.reader-action-bar)) {
    scroll-padding-bottom: calc(12rem + env(safe-area-inset-bottom));
  }

  :global(.prose-glass table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  :global(.prose-glass pre) {
    max-width: 100%;
    overflow-x: auto;
  }

  :global(.prose-glass.prose h1) {
    font-size: 1.6em;
  }

  :global(.prose-glass.prose h2) {
    font-size: 1.35em;
  }

  :global(.prose-glass.prose h3) {
    font-size: 1.15em;
  }

  :global(.prose-glass.prose h4) {
    font-size: 1.05em;
  }

  :global(.prose-glass.prose ul) {
    list-style-type: disc;
  }

  :global(.prose-glass.prose ol) {
    list-style-type: decimal;
  }

  @media (min-width: 768px) {
    :global(#main-content:has(.reader-action-bar)) {
      scroll-padding-bottom: 8rem;
    }
  }
</style>
