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

  return json({ feeds: rows });
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

  let { url, title, category } = body;

  if (!url || typeof url !== 'string') {
    return json({ error: 'Feed URL is required' }, { status: 400 });
  }

  // Basic URL validation
  try {
    new URL(url);
  } catch {
    return json({ error: 'Invalid URL format' }, { status: 400 });
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
    normalizedUrl = redditSource.fetchUrl;
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
