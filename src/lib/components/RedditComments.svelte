<script lang="ts">
  import { onMount } from 'svelte';
  import { formatContent } from '#lib/utils/format.ts';
  import { fetchWithCsrf } from '#lib/client/csrf.ts';
  import { type RedditComment } from '#lib/reddit-comments.ts';

  type Comment = RedditComment;

  let {
    permalink,
    useProxy = false,
  }: {
    permalink: string;
    useProxy?: boolean;
    proxyBaseUrl?: string | null;
  } = $props();

  let comments = $state<Comment[]>([]);
  let loading = $state(true);
  let error = $state('');
  let expanded = $state(true);
  let collapsedComments = $state<Record<string, boolean>>({});
  let requestSeq = 0;

  const MAX_VISUAL_INDENT_DEPTH = 4;
  const commentsId = $props.id();

  function timeAgo(iso: string): string {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diff = Math.max(0, Math.floor((now - then) / 1000));
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  }

  async function fetchCommentsFromServer(url: string): Promise<Comment[]> {
    const res = await fetchWithCsrf('/api/reddit/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, useProxy }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Error ${res.status}`);
    }

    const data = await res.json();
    return data.comments || [];
  }

  async function loadComments(targetPermalink = permalink) {
    const seq = ++requestSeq;
    loading = true;
    error = '';
    collapsedComments = {};
    try {
      const loaded = await fetchCommentsFromServer(targetPermalink);
      if (seq !== requestSeq) return;
      comments = loaded;
      error = '';
    } catch (err: unknown) {
      if (seq !== requestSeq) return;
      comments = [];
      error = err instanceof Error ? err.message : 'Failed to load comments';
    } finally {
      if (seq === requestSeq) {
        loading = false;
      }
    }
  }

  function toggleComment(id: string) {
    collapsedComments[id] = !collapsedComments[id];
  }

  onMount(() => {
    void loadComments(permalink);
  });
</script>

<div class="mt-8">
  <button
    class="flex w-full items-center justify-between gap-2 text-left"
    type="button"
    aria-expanded={expanded}
    aria-controls={commentsId}
    onclick={() => (expanded = !expanded)}
  >
    <div class="flex items-center gap-2">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        style="color: var(--color-primary-400);"
      >
        <path
          d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        />
      </svg>
      <span
        class="text-sm font-semibold"
        style="color: var(--color-surface-100);"
      >
        Reddit Comments
      </span>
      {#if !loading && !error}
        <span class="text-sm" style="color: var(--color-surface-300);">
          {comments.length} top-level
        </span>
      {/if}
    </div>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      class="transition-transform duration-200"
      class:rotate-180={expanded}
      style="color: var(--color-surface-300);"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  </button>

  <div id={commentsId} class="mt-3 space-y-3" hidden={!expanded}>
    {#if loading}
      <div
        role="status"
        class="flex items-center gap-2 py-4 text-sm"
        style="color: var(--color-surface-300);"
      >
        <div
          class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-500 border-t-transparent"
        ></div>
        Loading comments...
      </div>
    {:else if error}
      <div
        role="alert"
        class="flex flex-wrap items-center justify-between gap-3 rounded-sm border px-3 py-2.5 text-sm"
        style="color: var(--color-error-300); border-color: color-mix(in oklch, var(--color-error-500) 28%, transparent); background: color-mix(in oklch, var(--color-error-500) 8%, transparent);"
      >
        <span>{error}</span>
        <button
          type="button"
          class="btn btn-sm preset-tonal"
          onclick={() => void loadComments(permalink)}
        >
          Retry
        </button>
      </div>
    {:else if comments.length === 0}
      <div class="py-3 text-sm italic" style="color: var(--color-surface-300);">
        No comments yet.
      </div>
    {:else}
      {@render commentList(comments)}
    {/if}
  </div>
</div>

{#snippet commentList(items: Comment[], depth = 0)}
  <ul
    class="space-y-2 {depth > 0 && depth <= MAX_VISUAL_INDENT_DEPTH
      ? 'ml-2 sm:ml-3'
      : ''}"
    role="list"
  >
    {#each items as comment (comment.id)}
      {@const isCollapsed = Boolean(collapsedComments[comment.id])}
      <li
        class="min-w-0 rounded-sm px-2.5 py-2 sm:px-3"
        style={depth > 0
          ? 'border-left: 2px solid color-mix(in oklch, var(--color-primary-500) 20%, transparent);'
          : 'background: color-mix(in oklch, var(--color-surface-800) 30%, transparent);'}
      >
        <div class="mb-1 flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2 text-[11px]">
            {#if depth > MAX_VISUAL_INDENT_DEPTH}
              <span
                class="rounded px-1 py-0.5 text-[10px]"
                style="background: color-mix(in oklch, var(--color-primary-500) 12%, transparent); color: var(--color-primary-300);"
                title="Reply depth {depth}"
              >
                ↳ {depth}
              </span>
            {/if}
            <span
              class="font-semibold"
              style="color: var(--color-primary-300);"
            >
              u/{comment.author}
            </span>
            <span style="color: var(--color-surface-300);">
              {comment.score} pts
            </span>
            <span style="color: var(--color-surface-300);">
              {timeAgo(comment.createdAt)}
            </span>
          </div>
          <button
            type="button"
            class="rounded px-1.5 py-0.5 text-[11px] font-medium transition hover:bg-white/10"
            style="color: var(--color-surface-300);"
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed
              ? `Expand comment by ${comment.author}`
              : `Collapse comment by ${comment.author}`}
            onclick={() => toggleComment(comment.id)}
          >
            {isCollapsed
              ? `+ Expand${comment.replies?.length ? ` (${comment.replies.length})` : ''}`
              : '−'}
          </button>
        </div>
        {#if !isCollapsed}
          <div
            class="prose prose-sm prose-glass max-w-none min-w-0 overflow-x-auto break-words text-sm leading-relaxed"
            style="color: color-mix(in oklch, var(--color-surface-100) 85%, transparent);"
          >
            {@html formatContent(comment.body, 'https://www.reddit.com')}
          </div>
          {#if comment.replies?.length}
            {@render commentList(comment.replies, depth + 1)}
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}
