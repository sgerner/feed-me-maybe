import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import {
  isRedditUrl,
  normalizeRedditUrl,
  fetchRedditSource,
} from '$lib/server/sources/reddit';
import { getConfiguredProxyBaseUrl } from '$lib/server/proxy';
import { recordAppError } from '$lib/server/logging';
import { validatePublicUrl } from '$lib/server/network';
import { getFeedHealth, normalizeFeedUrl } from '$lib/server/feed-management';
import crypto from 'node:crypto';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const rows = db
    .prepare(
      'SELECT id, url, title, description, site_url, category, icon_url, enabled, use_proxy, error_count, last_fetch_status, last_fetch_at, last_error, source_type, source_metadata, created_at, updated_at FROM feeds ORDER BY title ASC',
    )
    .all();

  return json({
    feeds: (rows as Array<{ id: string }>).map((feed) => ({
      ...feed,
      health: getFeedHealth(feed.id),
    })),
  });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { url: requestedUrl, category } = body;
  let title = body.title;

  if (!requestedUrl || typeof requestedUrl !== 'string') {
    return json({ error: 'Feed URL is required' }, { status: 400 });
  }

  // Reject unsupported protocols, embedded credentials, and obvious private
  // network targets before storing a user-controlled feed URL.
  let url: string;
  try {
    url = normalizeFeedUrl(validatePublicUrl(requestedUrl).href);
  } catch {
    return json(
      { error: 'Only public http/https feed URLs are supported' },
      { status: 400 },
    );
  }

  const db = getDb();
  const now = new Date();
  const id = crypto.randomUUID();
  const proxyBaseUrl = getConfiguredProxyBaseUrl();

  let sourceType = 'rss';
  let sourceMetadata = '{}';
  let normalizedUrl = url;
  let useProxy = false;

  // Detect and validate Reddit URLs
  if (isRedditUrl(url)) {
    const redditSource = normalizeRedditUrl(url);
    let validation = await fetchRedditSource(redditSource);
    if (!validation.success && proxyBaseUrl) {
      const proxiedValidation = await fetchRedditSource(redditSource, {
        proxyBaseUrl,
      });
      if (proxiedValidation.success) {
        validation = proxiedValidation;
        useProxy = true;
      }
    }
    if (!validation.success) {
      recordAppError({
        source: 'api.feeds.create',
        error: new Error(validation.error || 'Reddit validation failed'),
        details: {
          url,
          proxyConfigured: Boolean(proxyBaseUrl),
          proxyUsed: useProxy,
        },
        path: '/api/feeds',
        method: 'POST',
      });
      return json(
        {
          error:
            validation.error ||
            'This looks like a Reddit URL, but Reddit did not return a readable JSON feed. Check that the subreddit, user, or search URL exists.',
        },
        { status: 422 },
      );
    }
    sourceType = 'reddit';
    sourceMetadata = JSON.stringify({
      originalUrl: url,
      redditKind: redditSource.redditKind,
      subreddit: redditSource.subreddit,
      username: redditSource.username,
      query: redditSource.query,
    });
    normalizedUrl = redditSource.normalizedUrl;
    // Use subreddit or username as default title if none provided
    if (!title) {
      title =
        validation.title ||
        redditSource.subreddit ||
        redditSource.username ||
        'Reddit';
    }
  }

  try {
    db.prepare(
      'INSERT INTO feeds (id, url, title, category, source_type, source_metadata, use_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      normalizedUrl,
      title || '',
      category || '',
      sourceType,
      sourceMetadata,
      useProxy ? 1 : 0,
      now.getTime(),
      now.getTime(),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.includes('UNIQUE constraint')) {
      return json({ error: 'Feed URL already exists' }, { status: 409 });
    }
    return json({ error: 'Failed to create feed' }, { status: 500 });
  }

  const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(id);
  return json({ feed }, { status: 201 });
};
