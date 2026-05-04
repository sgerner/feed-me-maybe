import type { FetchResult, FetchedItem } from '$lib/server/feed/fetcher';
import { buildProxiedUrl } from '$lib/server/proxy';

export type RedditKind =
  | 'subreddit'
  | 'subreddit_listing'
  | 'search'
  | 'user'
  | 'comments'
  | 'unknown';

export interface RedditNormalizedSource {
  originalUrl: string;
  normalizedUrl: string;
  redditKind: RedditKind;
  fetchUrl: string;
  title?: string;
  subreddit?: string;
  username?: string;
  query?: string;
}

const REDDIT_HOSTS = new Set([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'm.reddit.com',
]);

export function isRedditUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return REDDIT_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function ensureHttpsWww(input: string): URL {
  const url = new URL(input);
  url.protocol = 'https:';
  url.hostname = 'www.reddit.com';
  return url;
}

function stripJsonSuffix(path: string): string {
  return path.replace(/\.json$/i, '');
}

function addLimitIfMissing(url: URL, defaultLimit = 25): void {
  if (!url.searchParams.has('limit')) {
    url.searchParams.set('limit', String(defaultLimit));
  }
}

export function normalizeRedditUrl(input: string): RedditNormalizedSource {
  const url = ensureHttpsWww(input);
  const path = stripJsonSuffix(url.pathname).replace(/\/$/, '');
  const parts = path.split('/').filter(Boolean);

  let redditKind: RedditKind = 'unknown';
  let fetchUrl = '';
  let subreddit: string | undefined;
  let username: string | undefined;
  let query: string | undefined;

  // /r/subreddit/comments/xxx/... => comments/single post
  if (
    parts.length >= 4 &&
    (parts[0] === 'r' || parts[0] === 'R') &&
    parts[2] === 'comments'
  ) {
    redditKind = 'comments';
    subreddit = parts[1];
    fetchUrl = `${url.origin}${path}.json`;
    return {
      originalUrl: input,
      normalizedUrl: url.href,
      redditKind,
      fetchUrl,
      subreddit,
    };
  }

  // /r/subreddit/search?q=...
  if (
    parts.length >= 3 &&
    (parts[0] === 'r' || parts[0] === 'R') &&
    parts[2] === 'search'
  ) {
    redditKind = 'search';
    subreddit = parts[1];
    query = url.searchParams.get('q') || undefined;
    const searchUrl = new URL(url.href);
    searchUrl.pathname = `${path}.json`;
    addLimitIfMissing(searchUrl);
    fetchUrl = searchUrl.href;
    return {
      originalUrl: input,
      normalizedUrl: url.href,
      redditKind,
      fetchUrl,
      subreddit,
      query,
    };
  }

  // /search?q=...
  if (parts[0] === 'search') {
    redditKind = 'search';
    query = url.searchParams.get('q') || undefined;
    const searchUrl = new URL(url.href);
    searchUrl.pathname = `${path}.json`;
    addLimitIfMissing(searchUrl);
    fetchUrl = searchUrl.href;
    return {
      originalUrl: input,
      normalizedUrl: url.href,
      redditKind,
      fetchUrl,
      query,
    };
  }

  // /user/username/... or /u/username/...
  if (parts[0] === 'user' || parts[0] === 'u') {
    redditKind = 'user';
    username = parts[1];
    const userPath = parts.slice(0, 3).join('/');
    const userUrl = new URL(url.href);
    userUrl.pathname = `/${userPath}.json`;
    addLimitIfMissing(userUrl);
    fetchUrl = userUrl.href;
    return {
      originalUrl: input,
      normalizedUrl: url.href,
      redditKind,
      fetchUrl,
      username,
    };
  }

  // /r/subreddit/new, /hot, /top, /rising
  if (parts.length >= 2 && (parts[0] === 'r' || parts[0] === 'R')) {
    subreddit = parts[1];
    if (
      parts.length >= 3 &&
      ['new', 'hot', 'top', 'rising'].includes(parts[2])
    ) {
      redditKind = 'subreddit_listing';
      const listingUrl = new URL(url.href);
      listingUrl.pathname = `${path}.json`;
      addLimitIfMissing(listingUrl);
      fetchUrl = listingUrl.href;
    } else {
      // Default bare subreddit URLs to /new for a chronological feed
      redditKind = 'subreddit';
      const subUrl = new URL(url.href);
      subUrl.pathname = `${path}/new.json`;
      addLimitIfMissing(subUrl);
      fetchUrl = subUrl.href;
    }
    return {
      originalUrl: input,
      normalizedUrl: url.href,
      redditKind,
      fetchUrl,
      subreddit,
    };
  }

  // Fallback: append .json to whatever path we have
  const fallbackUrl = new URL(url.href);
  fallbackUrl.pathname = `${path}.json`;
  addLimitIfMissing(fallbackUrl);
  fetchUrl = fallbackUrl.href;
  return { originalUrl: input, normalizedUrl: url.href, redditKind, fetchUrl };
}

export function extractBestRedditImage(post: any): string | undefined {
  if (!post || typeof post !== 'object') return undefined;

  // Prefer preview images
  const preview = post.preview;
  if (preview?.images?.length) {
    const img = preview.images[0];
    if (img?.source?.url) {
      return decodeHtmlEntities(img.source.url);
    }
    if (img?.resolutions?.length) {
      const best = img.resolutions[img.resolutions.length - 1];
      if (best?.url) return decodeHtmlEntities(best.url);
    }
  }

  // thumbnail (skip default reddit icons)
  if (
    post.thumbnail &&
    typeof post.thumbnail === 'string' &&
    post.thumbnail.startsWith('http')
  ) {
    return post.thumbnail;
  }

  // media metadata (galleries)
  const mediaMeta = post.media_metadata;
  if (mediaMeta) {
    const firstKey = Object.keys(mediaMeta)[0];
    if (firstKey) {
      const first = mediaMeta[firstKey];
      if (first?.s?.u) return decodeHtmlEntities(first.s.u);
      if (first?.s?.gif) return decodeHtmlEntities(first.s.gif);
    }
  }

  return undefined;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#39;/g, "'")
    .replace(/&#47;/g, '/');
}

function stripHtmlOrDecode(html: string | null | undefined): string | null {
  if (!html) return null;
  // Reddit HTML entities are often escaped inside the JSON string
  let text = html
    .replace(/<!--.*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
  return text.trim() || null;
}

export function parseRedditPost(post: any): FetchedItem {
  const permalink = post.permalink
    ? `https://www.reddit.com${post.permalink}`
    : post.url;

  const selftext =
    post.selftext || stripHtmlOrDecode(post.selftext_html) || null;

  const isFullContent = Boolean(post.is_self && selftext);

  const categories: string[] = [];
  if (post.subreddit) categories.push(`r/${post.subreddit}`);
  if (post.link_flair_text) categories.push(post.link_flair_text);

  return {
    guid: `reddit_${post.id}`,
    url: permalink,
    title: post.title || '(untitled Reddit post)',
    author: post.author ? `u/${post.author}` : undefined,
    summary: selftext || post.title || undefined,
    content: selftext || undefined,
    imageUrl: extractBestRedditImage(post),
    externalUrl: post.is_self ? undefined : post.url,
    categories,
    publishedAt: post.created_utc
      ? new Date(post.created_utc * 1000)
      : undefined,
  };
}

function extractCommentsPreview(commentsListing: any): any[] | undefined {
  if (!commentsListing?.data?.children) return undefined;
  return commentsListing.data.children
    .slice(0, 5)
    .map((child: any) => {
      const c = child.data;
      if (!c) return null;
      return {
        id: c.id,
        author: c.author,
        body: c.body,
        score: c.score,
        createdAt: c.created_utc
          ? new Date(c.created_utc * 1000).toISOString()
          : null,
      };
    })
    .filter(Boolean);
}

function parseRedditJson(json: any): { items: FetchedItem[]; title?: string } {
  const items: FetchedItem[] = [];

  // Comments endpoint returns an array
  if (Array.isArray(json)) {
    const postListing = json[0];
    const commentsListing = json[1];
    const post = postListing?.data?.children?.[0]?.data;
    if (post) {
      const item = parseRedditPost(post);
      const comments = extractCommentsPreview(commentsListing);
      if (comments) {
        // Store comments preview in a way that won't collide with existing fields
        // We can encode it into content or summary, but better to keep it minimal.
        // For now, append to summary as a lightweight preview.
        const commentsText = comments
          .map((c: any) => `u/${c.author}: ${c.body}`)
          .join('\n---\n');
        if (commentsText) {
          item.summary = [item.summary, 'Top comments:', commentsText]
            .filter(Boolean)
            .join('\n\n');
        }
      }
      items.push(item);
    }
    return { items, title: post ? `r/${post.subreddit}` : undefined };
  }

  // Listing endpoint
  const children = json?.data?.children;
  if (!Array.isArray(children)) {
    return { items };
  }

  for (const child of children) {
    const post = child?.data;
    if (!post) continue;
    items.push(parseRedditPost(post));
  }

  // Try to infer a title from the first post's subreddit or from URL params
  let title: string | undefined;
  if (items.length > 0 && items[0].categories?.length) {
    const sub = items[0].categories.find((c) => c.startsWith('r/'));
    if (sub) title = sub;
  }

  return { items, title };
}

export async function fetchRedditSource(
  source: RedditNormalizedSource,
  options: { proxyBaseUrl?: string } = {},
): Promise<FetchResult> {
  const userAgent = process.env.REDDIT_USER_AGENT || 'web:feed-me-maybe:v1.0 (by /u/sgerner)';
  const fetchUrl = buildProxiedUrl(source.fetchUrl, options.proxyBaseUrl);
  const headers: Record<string, string> = {
    'User-Agent': userAgent,
    Accept: 'application/json',
  };

  try {
    const response = await fetch(fetchUrl, {
      headers,
      signal: AbortSignal.timeout(15000),
    });

    if (response.status === 429) {
      return {
        success: false,
        items: [],
        error:
          'Reddit is rate limiting requests right now. Try again later or reduce refresh frequency for this source.',
        httpStatus: 429,
      };
    }

    if (response.status === 403) {
      return {
        success: false,
        items: [],
        error: 'Reddit blocked this request (403).',
        httpStatus: 403,
      };
    }

    if (response.status === 404) {
      return {
        success: false,
        items: [],
        error: 'Subreddit, user, or post not found (404).',
        httpStatus: 404,
      };
    }

    if (!response.ok) {
      return {
        success: false,
        items: [],
        error: `HTTP error ${response.status}`,
        httpStatus: response.status,
      };
    }

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    if (
      !contentType.includes('application/json') &&
      text.trim().startsWith('<')
    ) {
      return {
        success: false,
        items: [],
        error:
          'This looks like a Reddit URL, but Reddit did not return a readable JSON feed. Check that the subreddit, user, or search URL exists.',
      };
    }

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        success: false,
        items: [],
        error:
          'This looks like a Reddit URL, but Reddit did not return a readable JSON feed. Check that the subreddit, user, or search URL exists.',
      };
    }

    // Reddit sometimes returns error objects instead of listings
    if (json && (json.error || json.reason || json.message)) {
      const errorDetail = json.message || json.reason || String(json.error);
      return {
        success: false,
        items: [],
        error: `Reddit API error: ${errorDetail}`,
      };
    }

    const { items, title } = parseRedditJson(json);

    if (items.length === 0) {
      return {
        success: true,
        items: [],
        title: title || source.subreddit || source.username || 'Reddit',
      };
    }

    return {
      success: true,
      items,
      title: title || source.subreddit || source.username || 'Reddit',
    };
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : 'Unknown Reddit fetch error';
    return {
      success: false,
      items: [],
      error: errorMessage,
    };
  }
}
