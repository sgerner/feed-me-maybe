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
  const data = node.data;
  if (!data || data.body === undefined) return null;

  const replies: RedditComment[] = [];
  if (data.replies?.data?.children) {
    for (const child of data.replies.data.children) {
      const parsed = parseCommentNode(child, depth + 1);
      if (parsed) replies.push(parsed);
    }
  }

  return {
    id: data.id,
    author: data.author || '[deleted]',
    body: data.body || '',
    score: data.score ?? 0,
    createdAt: data.created_utc
      ? new Date(data.created_utc * 1000).toISOString()
      : '',
    depth,
    replies,
  };
}

export function normalizeRedditCommentsUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = 'https:';
  parsed.hostname = 'www.reddit.com';
  const path = parsed.pathname.replace(/\/$/, '');
  if (!path.endsWith('.json')) {
    parsed.pathname = `${path}.json`;
  }
  return parsed.href;
}

export function parseRedditCommentsResponse(data: unknown): RedditComment[] {
  if (!Array.isArray(data) || data.length < 2) return [];

  const commentsListing = data[1];
  const children = commentsListing?.data?.children || [];
  const comments: RedditComment[] = [];

  for (const child of children) {
    const parsed = parseCommentNode(child, 0);
    if (parsed) comments.push(parsed);
  }

  return comments;
}
