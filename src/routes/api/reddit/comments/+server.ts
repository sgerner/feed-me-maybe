import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export interface RedditComment {
  id: string;
  author: string;
  body: string;
  score: number;
  createdAt: string;
  depth: number;
  replies: RedditComment[];
}

function parseCommentNode(node: any, depth = 0): RedditComment | null {
  if (!node || node.kind === 'more') return null;
  const d = node.data;
  if (!d || d.body === undefined) return null;

  const replies: RedditComment[] = [];
  if (d.replies?.data?.children) {
    for (const child of d.replies.data.children) {
      const parsed = parseCommentNode(child, depth + 1);
      if (parsed) replies.push(parsed);
    }
  }

  return {
    id: d.id,
    author: d.author || '[deleted]',
    body: d.body || '',
    score: d.score ?? 0,
    createdAt: d.created_utc
      ? new Date(d.created_utc * 1000).toISOString()
      : '',
    depth,
    replies,
  };
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { url?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid body' }, { status: 400 });
  }

  const url = body.url;
  if (!url || typeof url !== 'string') {
    return json({ error: 'URL is required' }, { status: 400 });
  }

  // Validate it's a Reddit comments URL
  if (!url.includes('reddit.com')) {
    return json({ error: 'Not a Reddit URL' }, { status: 400 });
  }

  // Normalize to .json endpoint
  let jsonUrl = url;
  try {
    const parsed = new URL(url);
    parsed.protocol = 'https:';
    parsed.hostname = 'www.reddit.com';
    const path = parsed.pathname.replace(/\/$/, '');
    if (!path.endsWith('.json')) {
      parsed.pathname = `${path}.json`;
    }
    jsonUrl = parsed.href;
  } catch {
    return json({ error: 'Invalid URL' }, { status: 400 });
  }

  try {
    const response = await fetch(jsonUrl, {
      headers: {
        'User-Agent': 'FeedMeMaybe/1.0 by sgerner',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return json(
        { error: `Reddit returned HTTP ${response.status}` },
        { status: 502 },
      );
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length < 2) {
      return json(
        { error: 'Unexpected Reddit response format' },
        { status: 502 },
      );
    }

    const commentsListing = data[1];
    const children = commentsListing?.data?.children || [];

    const comments: RedditComment[] = [];
    for (const child of children) {
      const parsed = parseCommentNode(child, 0);
      if (parsed) comments.push(parsed);
    }

    return json({ comments });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Fetch failed';
    return json({ error: msg }, { status: 502 });
  }
};
