import type { RequestHandler } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import { fetchFeed } from '#lib/server/feed/fetcher.ts';
import { enqueueFeedFetch } from '#lib/server/feed/job-queue.ts';
import { wakePoller } from '#lib/server/poller.ts';
import {
  isRedditUrl,
  normalizeRedditUrl,
  fetchRedditSource,
} from '#lib/server/sources/reddit.ts';
import { getConfiguredProxyBaseUrl } from '#lib/server/proxy.ts';
import { recordAppError } from '#lib/server/logging.ts';
import { validatePublicUrl } from '#lib/server/network.ts';
import {
  getFeedHealth,
  normalizeFeedUrl,
} from '#lib/server/feed-management.ts';
import crypto from 'node:crypto';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const rows = db
    .prepare(
      'SELECT id, url, title, description, site_url, category, icon_url, enabled, use_proxy, error_count, last_fetch_status, last_fetch_at, last_error, source_type, source_metadata, created_at, updated_at FROM feeds ORDER BY title ASC',
    )
    .all();

  return Response.json({
    feeds: (rows as Array<{ id: string }>).map((feed) => ({
      ...feed,
      health: getFeedHealth(feed.id),
    })),
  });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error('Invalid body');
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const requestedUrl = body.url;
  const category =
    typeof body.category === 'string' ? body.category.trim() : '';
  const requestedTitle =
    typeof body.title === 'string' ? body.title.trim() : '';
  let title = requestedTitle;

  if (!requestedUrl || typeof requestedUrl !== 'string') {
    return Response.json(
      { error: 'Feed URL is required', field: 'url' },
      { status: 400 },
    );
  }

  // Reject unsupported protocols, embedded credentials, and obvious private
  // network targets before storing a user-controlled feed URL.
  let url: string;
  try {
    url = normalizeFeedUrl(validatePublicUrl(requestedUrl).href);
  } catch {
    return Response.json(
      { error: 'Only public http/https feed URLs are supported', field: 'url' },
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
      return Response.json(
        {
          error:
            validation.error ||
            'This looks like a Reddit URL, but Reddit did not return a readable JSON feed. Check that the subreddit, user, or search URL exists.',
          field: 'url',
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
  } else {
    const existing = db.prepare('SELECT id FROM feeds WHERE url = ?').get(url);
    if (existing)
      return Response.json(
        { error: 'Feed URL already exists', field: 'url' },
        { status: 409 },
      );
    const deadline = AbortSignal.timeout(15_000);
    let result = await fetchFeed(url, { discover: true, deadline });
    if (!result.success && proxyBaseUrl && !deadline.aborted) {
      const throughProxy = await fetchFeed(url, {
        discover: true,
        proxyBaseUrl,
        deadline,
      });
      if (throughProxy.success) {
        result = throughProxy;
        useProxy = true;
      }
    }
    if (!result.success || !result.subscriptionUrl) {
      return Response.json(
        {
          error: result.error || 'This URL did not return a readable feed',
          field: 'url',
        },
        { status: 422 },
      );
    }
    normalizedUrl = normalizeFeedUrl(result.subscriptionUrl);
    if (!title) title = result.title ?? '';
  }

  try {
    db.transaction(() => {
      db.prepare(
        'INSERT INTO feeds (id, url, title, custom_title, category, source_type, source_metadata, use_proxy, poll_interval_mins, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
      ).run(
        id,
        normalizedUrl,
        title || '',
        requestedTitle ? 1 : 0,
        category || '',
        sourceType,
        sourceMetadata,
        useProxy ? 1 : 0,
        now.getTime(),
        now.getTime(),
      );
      enqueueFeedFetch(id, { now: now.getTime() });
    }).immediate();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.includes('UNIQUE constraint')) {
      return Response.json(
        { error: 'Feed URL already exists', field: 'url' },
        { status: 409 },
      );
    }
    return Response.json({ error: 'Failed to create feed' }, { status: 500 });
  }

  wakePoller();
  const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(id);
  return Response.json({ feed }, { status: 201 });
};
