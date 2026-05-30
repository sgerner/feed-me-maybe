import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildProxiedUrl, getConfiguredProxyBaseUrl } from '$lib/server/proxy';
import {
  normalizeRedditCommentsUrl,
  parseRedditCommentsResponse,
} from '$lib/reddit-comments';
import { recordAppError } from '$lib/server/logging';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { url?: string; useProxy?: boolean };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid body' }, { status: 400 });
  }

  const url = body.url;
  if (!url || typeof url !== 'string') {
    return json({ error: 'URL is required' }, { status: 400 });
  }

  if (!url.includes('reddit.com')) {
    return json({ error: 'Not a Reddit URL' }, { status: 400 });
  }

  let jsonUrl = url;
  try {
    jsonUrl = normalizeRedditCommentsUrl(url);
  } catch {
    return json({ error: 'Invalid URL' }, { status: 400 });
  }

  const proxyBaseUrl = getConfiguredProxyBaseUrl();
  const userAgent = process.env.REDDIT_USER_AGENT || 'web:feed-me-maybe:v1.0 (by /u/sgerner)';

  // Always use proxy for Reddit if available, regardless of what the client said,
  // because we know Reddit blocks most server IPs.
  const fetchUrl = proxyBaseUrl ? buildProxiedUrl(jsonUrl, proxyBaseUrl) : jsonUrl;

  let response;
  try {
    response = await fetch(fetchUrl, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    // If we get a 403, try old.reddit.com as it sometimes has different blocking rules
    if (response.status === 403 && fetchUrl.includes('www.reddit.com')) {
      const oldRedditUrl = fetchUrl.replace('www.reddit.com', 'old.reddit.com');
      const secondAttempt = await fetch(oldRedditUrl, {
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (secondAttempt.ok) {
        response = secondAttempt;
      }
    }

    // If still 403, try with a browser User-Agent
    if (response.status === 403) {
      const browserUA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      const thirdAttempt = await fetch(fetchUrl, {
        headers: {
          'User-Agent': browserUA,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (thirdAttempt.ok) {
        response = thirdAttempt;
      }
    }

    if (!response.ok) {
      recordAppError({
        source: 'api.reddit.comments',
        error: new Error(`Reddit returned HTTP ${response.status}`),
        details: {
          url,
          jsonUrl,
          fetchUrl,
          useProxy: Boolean(body.useProxy),
          proxyConfigured: Boolean(proxyBaseUrl),
        },
        path: '/api/reddit/comments',
        method: 'POST',
      });
      return json(
        { error: `Reddit returned HTTP ${response.status}` },
        { status: 502 },
      );
    }

    const data = await response.json();
    if (!Array.isArray(data) || data.length < 2) {
      recordAppError({
        source: 'api.reddit.comments',
        error: new Error('Unexpected Reddit response format'),
        details: {
          url,
          jsonUrl,
          fetchUrl,
          useProxy: Boolean(body.useProxy),
          proxyConfigured: Boolean(proxyBaseUrl),
        },
        path: '/api/reddit/comments',
        method: 'POST',
      });
      return json(
        { error: 'Unexpected Reddit response format' },
        { status: 502 },
      );
    }

    return json({ comments: parseRedditCommentsResponse(data) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Fetch failed';
    recordAppError({
      source: 'api.reddit.comments',
      error: err,
      details: {
        url,
        jsonUrl,
        fetchUrl,
        useProxy: Boolean(body.useProxy),
        proxyConfigured: Boolean(proxyBaseUrl),
      },
      path: '/api/reddit/comments',
      method: 'POST',
    });
    return json({ error: msg }, { status: 502 });
  }
};
