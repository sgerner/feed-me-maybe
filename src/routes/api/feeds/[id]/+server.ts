import type { RequestHandler } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import { isArticleOpenMode } from '#lib/constants/article-open-modes.ts';
import {
  discoverAndValidateFeedSource,
  getFeedHealth,
  normalizeFeedUrl,
} from '#lib/server/feed-management.ts';
import type { FetchResult } from '#lib/server/feed/fetcher.ts';
import { commitFetchedFeedResult } from '#lib/server/feed/ingester.ts';
import { validateCssSelector } from '#lib/server/archive.ts';
import { validatePublicUrl } from '#lib/server/network.ts';
import { isRedditUrl } from '#lib/server/sources/reddit.ts';
import {
  cancelQueuedArticleWorkForFeeds,
  cancelQueuedCrawlWorkForFeeds,
  deleteJobsForFeeds,
  enqueueFeedFetch,
  FEED_FETCH_JOB_TYPE,
} from '#lib/server/feed/job-queue.ts';
import { getConfiguredProxyBaseUrl } from '#lib/server/proxy.ts';
import { scheduleNextPoll, wakePoller } from '#lib/server/poller.ts';
import { readJsonObject } from '#lib/server/request-body.ts';

function readFeedWithCounts(feedId: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT f.*,
              (SELECT COUNT(*) FROM articles a WHERE a.feed_id = f.id AND COALESCE(a.saved, 0) = 1) AS saved_count
       FROM feeds f WHERE f.id = ?`,
    )
    .get(feedId);
}

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const feed = readFeedWithCounts(params.id);

  if (!feed) {
    return Response.json({ error: 'Feed not found' }, { status: 404 });
  }

  return Response.json({ feed, health: getFeedHealth(params.id) });
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const existing = db
    .prepare(
      'SELECT url, title, custom_title, source_type, enabled, use_proxy, fetch_full_text, css_selector, poll_interval_mins FROM feeds WHERE id = ?',
    )
    .get(params.id) as
    | {
        url: string;
        title: string | null;
        custom_title: number;
        source_type: string | null;
        enabled: number;
        use_proxy: number;
        fetch_full_text: number;
        css_selector: string | null;
        poll_interval_mins: number | null;
      }
    | undefined;
  if (!existing) {
    return Response.json({ error: 'Feed not found' }, { status: 404 });
  }

  const body = await readJsonObject(request);
  if (!body) {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const updates: string[] = [];
  const values: (string | number | boolean | null)[] = [];
  let nextCustomTitle = Boolean(existing.custom_title);
  let nextEnabled = Boolean(existing.enabled);
  let useProxyChanged = false;
  let fullTextDisabledNow = false;
  let reEnabled = false;
  let pollIntervalChanged = false;

  if (body.title !== undefined) {
    if (typeof body.title !== 'string') {
      return Response.json({ error: 'title must be text' }, { status: 400 });
    }
    const trimmedTitle = body.title.trim();
    const existingTitle = (existing.title ?? '').trim();
    if (!trimmedTitle) {
      // Clearing the title releases custom_title without blanking feeds.title
      // or wiping article_search.feed_title.
      nextCustomTitle = false;
      updates.push('custom_title = 0');
    } else if (trimmedTitle !== existingTitle) {
      nextCustomTitle = true;
      updates.push('title = ?', 'custom_title = 1');
      values.push(trimmedTitle);
    } else {
      updates.push(
        existing.custom_title ? 'custom_title = 1' : 'custom_title = 0',
      );
    }
  }

  if (body.category !== undefined) {
    if (typeof body.category !== 'string') {
      return Response.json({ error: 'category must be text' }, { status: 400 });
    }
    updates.push('category = ?');
    values.push(body.category.trim());
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return Response.json(
        { error: 'enabled must be a boolean' },
        { status: 400 },
      );
    }
    nextEnabled = body.enabled;
    reEnabled = body.enabled && !existing.enabled;
    updates.push('enabled = ?');
    values.push(body.enabled ? 1 : 0);
  }

  if (body.use_proxy !== undefined) {
    if (typeof body.use_proxy !== 'boolean') {
      return Response.json(
        { error: 'use_proxy must be a boolean' },
        { status: 400 },
      );
    }
    useProxyChanged = (body.use_proxy ? 1 : 0) !== existing.use_proxy;
    updates.push('use_proxy = ?');
    values.push(body.use_proxy ? 1 : 0);
  }

  if (body.fetch_full_text !== undefined) {
    if (typeof body.fetch_full_text !== 'boolean') {
      return Response.json(
        { error: 'fetch_full_text must be a boolean' },
        { status: 400 },
      );
    }
    fullTextDisabledNow =
      Boolean(existing.fetch_full_text) && !body.fetch_full_text;
    updates.push('fetch_full_text = ?');
    values.push(body.fetch_full_text ? 1 : 0);
  }

  if (body.css_selector !== undefined) {
    if (body.css_selector !== null && typeof body.css_selector !== 'string') {
      return Response.json(
        { error: 'css_selector must be a string or null' },
        { status: 400 },
      );
    }
    const validation = validateCssSelector(body.css_selector ?? '');
    if (!validation.valid) {
      return Response.json(
        { error: validation.error, field: 'css_selector' },
        { status: 400 },
      );
    }
    updates.push('css_selector = ?');
    values.push(validation.normalized);
  }

  if (body.open_mode !== undefined) {
    if (body.open_mode !== null && !isArticleOpenMode(body.open_mode)) {
      return Response.json({ error: 'Invalid open mode' }, { status: 400 });
    }
    updates.push('open_mode = ?');
    values.push(body.open_mode);
  }

  if (body.poll_interval_mins !== undefined) {
    if (body.poll_interval_mins === null || body.poll_interval_mins === '') {
      pollIntervalChanged = existing.poll_interval_mins !== null;
      updates.push('poll_interval_mins = ?');
      values.push(null);
    } else if (
      typeof body.poll_interval_mins !== 'number' ||
      !Number.isInteger(body.poll_interval_mins) ||
      body.poll_interval_mins < 1 ||
      body.poll_interval_mins > 1440
    ) {
      return Response.json(
        { error: 'poll_interval_mins must be an integer between 1 and 1440' },
        { status: 400 },
      );
    } else {
      pollIntervalChanged =
        existing.poll_interval_mins !== body.poll_interval_mins;
      updates.push('poll_interval_mins = ?');
      values.push(body.poll_interval_mins);
    }
  }

  let urlChanged = false;
  let validatedUrlResult: FetchResult | null = null;
  if (body.url !== undefined) {
    let url: string;
    try {
      if (typeof body.url !== 'string') throw new Error('Invalid URL');
      url = normalizeFeedUrl(validatePublicUrl(body.url.trim()).href);
    } catch {
      return Response.json(
        { error: 'Enter a public HTTP or HTTPS feed URL' },
        { status: 400 },
      );
    }
    if (url !== existing.url) {
      const proxyBaseUrl = getConfiguredProxyBaseUrl();
      const requestedUseProxy =
        typeof body.use_proxy === 'boolean'
          ? body.use_proxy
          : Boolean(existing.use_proxy);
      const isReddit = isRedditUrl(url);
      if (
        (existing.source_type === 'reddit' || isReddit) &&
        (existing.source_type !== 'reddit' || !isReddit)
      ) {
        return Response.json(
          { error: 'The new URL must use the same source type' },
          { status: 422 },
        );
      }

      const discovered = await discoverAndValidateFeedSource({
        url,
        proxyBaseUrl,
        requestedUseProxy,
        allowProxyFallback: !requestedUseProxy && body.use_proxy === undefined,
      });
      if (!discovered.ok) {
        return Response.json({ error: discovered.error }, { status: 422 });
      }

      url = discovered.normalizedUrl;
      validatedUrlResult = discovered.fetchResult;
      if (discovered.sourceType === 'reddit') {
        updates.push('source_metadata = ?');
        values.push(discovered.sourceMetadata);
      }
      if (discovered.autoEnabledProxy) {
        useProxyChanged = !existing.use_proxy;
        updates.push('use_proxy = 1');
      }
      if (url !== existing.url) {
        urlChanged = true;
        if (discovered.sourceType === 'rss') {
          updates.push('description = ?', 'site_url = ?', 'icon_url = ?');
          values.push(
            discovered.fetchResult.description ?? '',
            discovered.fetchResult.link ?? '',
            discovered.fetchResult.imageUrl ?? '',
          );
        }
        if (!nextCustomTitle && discovered.fetchResult.title) {
          updates.push('title = ?');
          values.push(discovered.fetchResult.title);
        }
      }
      if (urlChanged) {
        updates.push(
          'url = ?',
          'etag = ?',
          'last_modified_header = ?',
          'last_fetch_at = NULL',
          'last_error = NULL',
          "last_fetch_status = 'never'",
          'error_count = 0',
          'fetch_count_since_change = 0',
        );
        values.push(
          url,
          discovered.fetchResult.etag || null,
          discovered.fetchResult.lastModified || null,
        );
      }
    }
  }

  if (!urlChanged && (useProxyChanged || reEnabled)) {
    updates.push(
      'error_count = 0',
      'last_error = NULL',
      "last_fetch_status = CASE WHEN last_fetch_status = 'error' THEN 'never' ELSE last_fetch_status END",
    );
  }

  if (updates.length === 0) {
    return Response.json(
      { error: 'No valid fields to update' },
      { status: 400 },
    );
  }

  const now = Date.now();
  const disabledNow = Boolean(existing.enabled) && !nextEnabled;
  updates.push('updated_at = ?');
  values.push(now);
  values.push(params.id);

  try {
    const changed = db
      .transaction(() => {
        const result = db
          .prepare(
            `UPDATE feeds SET ${updates.join(', ')} WHERE id = ? AND url = ?`,
          )
          .run(...values, existing.url);
        if (!result.changes) return 0;

        if (disabledNow) {
          cancelQueuedArticleWorkForFeeds([params.id], db);
        } else if (fullTextDisabledNow) {
          cancelQueuedCrawlWorkForFeeds([params.id], db);
        }

        if (urlChanged) {
          // Retry delays belong to the previous subscription URL.
          db.prepare(
            `UPDATE jobs SET status = 'completed', completed_at = ?
            WHERE type = ? AND status = 'queued' AND json_extract(payload, '$.feedId') = ?`,
          ).run(now, FEED_FETCH_JOB_TYPE, params.id);
          if (
            nextEnabled &&
            (!validatedUrlResult || validatedUrlResult.items.length === 0)
          ) {
            enqueueFeedFetch(params.id, { force: true, now });
          }
        } else if ((useProxyChanged || reEnabled) && nextEnabled) {
          enqueueFeedFetch(params.id, { force: true, now });
        }
        return result.changes;
      })
      .immediate();
    if (!changed)
      return Response.json(
        { error: 'This feed changed. Reload and try again.' },
        { status: 409 },
      );

    if (
      urlChanged &&
      validatedUrlResult &&
      validatedUrlResult.items.length > 0
    ) {
      commitFetchedFeedResult({
        feedId: params.id,
        fetchResult: validatedUrlResult,
        startedAt: now,
        customTitle: nextCustomTitle,
        fetchCountSinceChange: 0,
      });
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
      return Response.json(
        { error: 'This feed URL is already subscribed' },
        { status: 409 },
      );
    }
    return Response.json({ error: 'Failed to update feed' }, { status: 500 });
  }

  if ((urlChanged || useProxyChanged || reEnabled) && nextEnabled) {
    wakePoller();
  } else if (pollIntervalChanged && nextEnabled) {
    scheduleNextPoll();
  }
  const feed = readFeedWithCounts(params.id);
  return Response.json({ feed, health: getFeedHealth(params.id) });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const deleted = db
    .transaction(() => {
      deleteJobsForFeeds([params.id], db);
      return db.prepare('DELETE FROM feeds WHERE id = ?').run(params.id)
        .changes;
    })
    .immediate();
  if (deleted === 0) {
    return Response.json({ error: 'Feed not found' }, { status: 404 });
  }
  return Response.json({ success: true });
};
