import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { isArticleOpenMode } from '$lib/constants/article-open-modes';
import { getFeedHealth, normalizeFeedUrl } from '$lib/server/feed-management';
import { fetchFeed } from '$lib/server/feed/fetcher';
import { validatePublicUrl } from '$lib/server/network';
import { isRedditUrl, normalizeRedditUrl } from '$lib/server/sources/reddit';
import {
  enqueueFeedFetch,
  FEED_FETCH_JOB_TYPE,
} from '$lib/server/feed/job-queue';
import { getConfiguredProxyBaseUrl } from '$lib/server/proxy';
import { wakePoller } from '$lib/server/poller';

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(params.id);

  if (!feed) {
    return json({ error: 'Feed not found' }, { status: 404 });
  }

  return json({ feed, health: getFeedHealth(params.id) });
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const existing = db
    .prepare(
      'SELECT url, source_type, enabled, use_proxy FROM feeds WHERE id = ?',
    )
    .get(params.id) as
    | {
        url: string;
        source_type: string | null;
        enabled: number;
        use_proxy: number;
      }
    | undefined;
  if (!existing) {
    return json({ error: 'Feed not found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error('Invalid body');
  } catch {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Build update SET clause dynamically
  const allowedFields = [
    'title',
    'category',
    'enabled',
    'open_mode',
    'use_proxy',
  ];
  const updates: string[] = [];
  const values: (string | number | boolean | null)[] = [];

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      if (
        (field === 'title' || field === 'category') &&
        typeof body[field] !== 'string'
      ) {
        return json({ error: `${field} must be text` }, { status: 400 });
      }
      if (field === 'enabled' && typeof body[field] !== 'boolean') {
        return json({ error: 'enabled must be a boolean' }, { status: 400 });
      }
      if (field === 'use_proxy' && typeof body[field] !== 'boolean') {
        return json({ error: 'use_proxy must be a boolean' }, { status: 400 });
      }
      if (
        field === 'open_mode' &&
        body[field] !== null &&
        !isArticleOpenMode(body[field])
      ) {
        return json({ error: 'Invalid open mode' }, { status: 400 });
      }
      updates.push(`${field === 'open_mode' ? 'open_mode' : field} = ?`);
      let val: string | number | boolean | null = body[field] as any;
      if (field === 'enabled') val = body[field] ? 1 : 0;
      if (field === 'use_proxy') val = body[field] ? 1 : 0;
      if (field === 'open_mode' && val === '') val = null;
      values.push(val);

      // If user is setting a custom title, flag it so it won't be overwritten by ingester
      if (field === 'title') {
        updates.push('custom_title = 1');
      }
    }
  }

  let urlChanged = false;
  if (body.url !== undefined) {
    let url: string;
    try {
      if (typeof body.url !== 'string') throw new Error('Invalid URL');
      url = normalizeFeedUrl(validatePublicUrl(body.url.trim()).href);
    } catch {
      return json(
        { error: 'Enter a public HTTP or HTTPS feed URL' },
        { status: 400 },
      );
    }
    if (url !== existing.url) {
      const isReddit = isRedditUrl(url);
      if (existing.source_type === 'reddit' || isReddit) {
        if (existing.source_type !== 'reddit' || !isReddit) {
          return json(
            { error: 'The new URL must use the same source type' },
            { status: 422 },
          );
        }
        const source = normalizeRedditUrl(url);
        const metadata = JSON.stringify({
          originalUrl: url,
          redditKind: source.redditKind,
          subreddit: source.subreddit,
          username: source.username,
          query: source.query,
        });
        url = source.normalizedUrl;
        updates.push('source_metadata = ?');
        values.push(metadata);
      } else {
        const result = await fetchFeed(url, {
          discover: true,
          proxyBaseUrl:
            (body.use_proxy ?? existing.use_proxy)
              ? getConfiguredProxyBaseUrl()
              : undefined,
        });
        if (!result.success || !result.subscriptionUrl) {
          return json(
            {
              error: result.error || 'This URL did not return a readable feed',
            },
            { status: 422 },
          );
        }
        url = normalizeFeedUrl(result.subscriptionUrl);
      }
      if (url !== existing.url) {
        urlChanged = true;
        updates.push(
          'url = ?',
          'etag = NULL',
          'last_modified_header = NULL',
          'last_fetch_at = NULL',
          'last_error = NULL',
          "last_fetch_status = 'never'",
          'error_count = 0',
          'fetch_count_since_change = 0',
        );
        values.push(url);
      }
    }
  }

  if (updates.length === 0) {
    return json({ error: 'No valid fields to update' }, { status: 400 });
  }

  updates.push('updated_at = ?');
  values.push(Date.now());
  values.push(params.id);

  try {
    const changed = db
      .transaction(() => {
        const result = db
          .prepare(
            `UPDATE feeds SET ${updates.join(', ')} WHERE id = ? AND url = ?`,
          )
          .run(...values, existing.url);
        if (result.changes && urlChanged) {
          // Retry delays belong to the previous subscription URL.
          db.prepare(
            `UPDATE jobs SET status = 'completed', completed_at = ?
            WHERE type = ? AND status = 'queued' AND json_extract(payload, '$.feedId') = ?`,
          ).run(Date.now(), FEED_FETCH_JOB_TYPE, params.id);
          if (body.enabled ?? existing.enabled)
            enqueueFeedFetch(params.id, { force: true });
        }
        return result.changes;
      })
      .immediate();
    if (!changed)
      return json(
        { error: 'This feed changed. Reload and try again.' },
        { status: 409 },
      );
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
      return json(
        { error: 'This feed URL is already subscribed' },
        { status: 409 },
      );
    }
    return json({ error: 'Failed to update feed' }, { status: 500 });
  }

  if (urlChanged) wakePoller();
  const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(params.id);
  return json({ feed, health: getFeedHealth(params.id) });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const result = db.prepare('DELETE FROM feeds WHERE id = ?').run(params.id);
  if (result.changes === 0) {
    return json({ error: 'Feed not found' }, { status: 404 });
  }
  return json({ success: true });
};
