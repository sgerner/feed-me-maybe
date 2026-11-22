import type { RequestHandler } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import { commitFetchedFeedResult } from '#lib/server/feed/ingester.ts';
import { wakePoller } from '#lib/server/poller.ts';
import { isRedditUrl } from '#lib/server/sources/reddit.ts';
import { getConfiguredProxyBaseUrl } from '#lib/server/proxy.ts';
import { recordAppError } from '#lib/server/logging.ts';
import { validateCssSelector } from '#lib/server/archive.ts';
import { validatePublicUrl } from '#lib/server/network.ts';
import {
  discoverAndValidateFeedSource,
  getAllFeedHealth,
  normalizeFeedUrl,
} from '#lib/server/feed-management.ts';
import { readJsonObject } from '#lib/server/request-body.ts';
import crypto from 'node:crypto';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT f.id, f.url, f.title, f.description, f.site_url, f.category,
              f.icon_url, f.enabled, f.use_proxy, f.fetch_full_text, f.css_selector,
              f.error_count, f.last_fetch_status, f.last_fetch_at, f.last_error,
              f.source_type, f.source_metadata, f.created_at, f.updated_at,
              COUNT(CASE WHEN COALESCE(a.read, 0) = 0 AND COALESCE(a.hidden, 0) = 0 AND COALESCE(a.rejected, 0) = 0 AND COALESCE(a.thumbs_down, 0) = 0 THEN 1 END) AS unread_count,
              COUNT(CASE WHEN COALESCE(a.saved, 0) = 1 THEN 1 END) AS saved_count,
              COUNT(CASE WHEN COALESCE(a.hidden, 0) = 0 AND COALESCE(a.rejected, 0) = 0 AND COALESCE(a.thumbs_down, 0) = 0 THEN 1 END) AS visible_count,
              COUNT(a.id) AS article_count
       FROM feeds f
       LEFT JOIN articles a ON a.feed_id = f.id
       GROUP BY f.id
       ORDER BY f.title ASC`,
    )
    .all() as Array<{
    id: string;
    enabled: number;
    unread_count: number;
    saved_count: number;
    visible_count: number;
    article_count: number;
    [key: string]: unknown;
  }>;

  const healthByFeed = new Map(
    getAllFeedHealth().map((health) => [health.feedId, health]),
  );
  const totalUnread = rows.reduce(
    (sum, feed) => (feed.enabled ? sum + Number(feed.unread_count || 0) : sum),
    0,
  );

  return Response.json({
    feeds: rows.map((feed) => ({
      ...feed,
      health: healthByFeed.get(feed.id) ?? null,
    })),
    totalUnread,
  });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await readJsonObject(request);
  if (!body) {
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

  let fetchFullText = false;
  if (body.fetch_full_text !== undefined) {
    if (typeof body.fetch_full_text !== 'boolean') {
      return Response.json(
        {
          error: 'fetch_full_text must be a boolean',
          field: 'fetch_full_text',
        },
        { status: 400 },
      );
    }
    fetchFullText = body.fetch_full_text;
  }

  let cssSelector = '';
  if (body.css_selector !== undefined && body.css_selector !== null) {
    if (typeof body.css_selector !== 'string') {
      return Response.json(
        { error: 'css_selector must be a string', field: 'css_selector' },
        { status: 400 },
      );
    }
    const selectorValidation = validateCssSelector(body.css_selector);
    if (!selectorValidation.valid) {
      return Response.json(
        { error: selectorValidation.error, field: 'css_selector' },
        { status: 400 },
      );
    }
    cssSelector = selectorValidation.normalized;
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
  const nowMs = now.getTime();
  const id = crypto.randomUUID();
  const proxyBaseUrl = getConfiguredProxyBaseUrl();

  if (!isRedditUrl(url)) {
    const existing = db.prepare('SELECT id FROM feeds WHERE url = ?').get(url);
    if (existing) {
      return Response.json(
        { error: 'Feed URL already exists', field: 'url' },
        { status: 409 },
      );
    }
  }

  const discovered = await discoverAndValidateFeedSource({
    url,
    proxyBaseUrl,
  });
  if (!discovered.ok) {
    if (discovered.sourceType === 'reddit') {
      recordAppError({
        source: 'api.feeds.create',
        error: new Error(discovered.error || 'Reddit validation failed'),
        details: {
          url,
          proxyConfigured: Boolean(proxyBaseUrl),
          proxyUsed: discovered.useProxy,
        },
        path: '/api/feeds',
        method: 'POST',
      });
    }
    return Response.json(
      {
        error: discovered.error,
        field: 'url',
      },
      { status: 422 },
    );
  }

  const {
    sourceType,
    normalizedUrl,
    sourceMetadata,
    useProxy,
    fetchResult,
    defaultTitle,
  } = discovered;
  if (!title) title = defaultTitle;

  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO feeds (
          id, url, title, custom_title, description, site_url, icon_url,
          category, source_type, source_metadata, use_proxy,
          fetch_full_text, css_selector,
          etag, last_modified_header, last_fetch_status, last_fetch_at,
          poll_interval_mins, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', ?, NULL, ?, ?)`,
      ).run(
        id,
        normalizedUrl,
        title || '',
        requestedTitle ? 1 : 0,
        fetchResult.description || '',
        fetchResult.link || '',
        fetchResult.imageUrl || '',
        category || '',
        sourceType,
        sourceMetadata,
        useProxy ? 1 : 0,
        fetchFullText ? 1 : 0,
        cssSelector,
        fetchResult.etag || null,
        fetchResult.lastModified || null,
        nowMs,
        nowMs,
        nowMs,
      );
    }).immediate();

    commitFetchedFeedResult({
      feedId: id,
      fetchResult,
      startedAt: nowMs,
      customTitle: Boolean(requestedTitle),
      fetchCountSinceChange: 0,
    });
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
