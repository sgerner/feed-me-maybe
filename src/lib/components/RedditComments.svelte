<script lang="ts">
  import { onMount } from 'svelte';
  import { formatContent } from '$lib/utils/format';
  import { buildProxyRequestUrl } from '$lib/proxy';
  import {
    normalizeRedditCommentsUrl,
    parseRedditCommentsResponse,
    type RedditComment,
  } from '$lib/reddit-comments';

  type Comment = RedditComment;

  let {
    permalink,
    useProxy = false,
    proxyBaseUrl = null,
  }: {
    permalink: string;
    useProxy?: boolean;
    proxyBaseUrl?: string | null;
  } = $props();

  let comments = $state<Comment[]>([]);
  let loading = $state(true);
  let error = $state('');
  let expanded = $state(true);

  function flatten(
    list: Comment[],
    out: (Comment & { depth: number })[] = [],
    depth = 0,
  ): (Comment & { depth: number })[] {
    for (const c of list) {
      out.push({ ...c, depth });
      if (c.replies?.length) {
        flatten(c.replies, out, depth + 1);
      }
    }
    return out;
  }

  function timeAgo(iso: string): string {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diff = Math.max(0, Math.floor((now - then) / 1000));
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  }

  async function fetchComments(endpointUrl: string): Promise<Comment[]> {
    const res = await fetch(endpointUrl, {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Error ${res.status}`);
    }

    const data = await res.json();
    return parseRedditCommentsResponse(data);
  }

  async function fetchCommentsFromServer(): Promise<Comment[]> {
    const res = await fetch('/api/reddit/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: permalink, useProxy }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Error ${res.status}`);
    }

    const data = await res.json();
    return data.comments || [];
  }

  onMount(async () => {
    try {
      const targetUrl = normalizeRedditCommentsUrl(permalink);
      const endpoints: string[] = [];

      if (useProxy && proxyBaseUrl) {
        endpoints.push(buildProxyRequestUrl(proxyBaseUrl, targetUrl));
      }
      endpoints.push(targetUrl);

      for (const endpointUrl of endpoints) {
        try {
          comments = await fetchComments(endpointUrl);
          error = '';
          return;
        } catch (err: unknown) {
          error = err instanceof Error ? err.message : 'Failed to load comments';
        }
      }

      comments = await fetchCommentsFromServer();
      error = '';
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : 'Failed to load comments';
    } finally {
      loading = false;
    }
  });

  const flatComments = $derived(flatten(comments));
</script>

<div class="mt-8">
  <button
    class="flex w-full items-center justify-between gap-2 text-left"
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
      {#if !loading}
        <span
          class="text-sm"
          style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);"
        >
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
      style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  </button>

  {#if expanded}
    <div class="mt-3 space-y-3">
      {#if loading}
        <div
          class="flex items-center gap-2 py-4 text-sm"
          style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);"
        >
          <div
            class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-500 border-t-transparent"
          ></div>
          Loading comments...
        </div>
      {:else if error}
        <div class="py-3 text-sm" style="color: var(--color-error-300);">
          {error}
        </div>
      {:else if flatComments.length === 0}
        <div
          class="py-3 text-sm italic"
          style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);"
        >
          No comments yet.
        </div>
      {:else}
        {#each flatComments as comment (comment.id)}
          <div
            class="rounded-sm py-2 px-3"
            style="
              margin-left: {comment.depth * 16}px;
              {comment.depth > 0
              ? 'border-left: 2px solid color-mix(in oklch, var(--color-primary-500) 20%, transparent);'
              : 'background: color-mix(in oklch, var(--color-surface-800) 30%, transparent);'}
            "
          >
            <div class="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
              <span
                class="font-semibold"
                style="color: var(--color-primary-300);"
              >
                u/{comment.author}
              </span>
              <span
                style="color: color-mix(in oklch, var(--color-surface-200) 45%, transparent);"
              >
                {comment.score} pts
              </span>
              <span
                style="color: color-mix(in oklch, var(--color-surface-200) 35%, transparent);"
              >
                {timeAgo(comment.createdAt)}
              </span>
            </div>
            <div
              class="prose prose-sm max-w-none text-sm leading-relaxed"
              style="color: color-mix(in oklch, var(--color-surface-100) 85%, transparent);"
            >
              {@html formatContent(comment.body)}
            </div>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>
