import type { RequestHandler } from './$types';
import { getDb } from '#lib/server/db/index.ts';
import {
  deleteJobsForFeeds,
  enqueueFeedFetch,
} from '#lib/server/feed/job-queue.ts';
import { wakePoller } from '#lib/server/poller.ts';
import { readJsonObject } from '#lib/server/request-body.ts';

type BatchAction = 'enable' | 'disable' | 'set_category' | 'delete';
const VALID_ACTIONS = new Set<BatchAction>([
  'enable',
  'disable',
  'set_category',
  'delete',
]);
const MAX_BATCH_SIZE = 500;

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await readJsonObject(request);
  if (!body) {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (
    !Array.isArray(body.feedIds) ||
    body.feedIds.length === 0 ||
    body.feedIds.some((id) => typeof id !== 'string' || !id.trim())
  ) {
    return Response.json(
      { error: 'feedIds must be a non-empty array of feed IDs' },
      { status: 400 },
    );
  }
  const feedIds = Array.from(
    new Set(body.feedIds.map((id) => (id as string).trim())),
  );
  if (feedIds.length > MAX_BATCH_SIZE) {
    return Response.json(
      { error: `Cannot modify more than ${MAX_BATCH_SIZE} feeds at once` },
      { status: 400 },
    );
  }

  if (
    typeof body.action !== 'string' ||
    !VALID_ACTIONS.has(body.action as BatchAction)
  ) {
    return Response.json({ error: 'Invalid batch action' }, { status: 400 });
  }
  const action = body.action as BatchAction;

  let nextCategory = '';
  if (action === 'set_category') {
    if (
      body.category !== undefined &&
      body.category !== null &&
      typeof body.category !== 'string'
    ) {
      return Response.json(
        { error: 'category must be text or null' },
        { status: 400 },
      );
    }
    nextCategory =
      typeof body.category === 'string' ? body.category.trim() : '';
  }

  const db = getDb();
  const now = Date.now();
  const placeholders = feedIds.map(() => '?').join(', ');

  let shouldWakePoller = false;
  const updated = db
    .transaction(() => {
      if (action === 'enable') {
        const disabledRows = db
          .prepare(
            `SELECT id FROM feeds WHERE id IN (${placeholders}) AND enabled = 0`,
          )
          .all(...feedIds) as Array<{ id: string }>;
        const result = db
          .prepare(
            `
            UPDATE feeds
            SET enabled = 1,
                error_count = CASE WHEN enabled = 0 THEN 0 ELSE error_count END,
                last_error = CASE WHEN enabled = 0 THEN NULL ELSE last_error END,
                last_fetch_status = CASE WHEN enabled = 0 AND last_fetch_status = 'error' THEN 'never' ELSE last_fetch_status END,
                updated_at = ?
            WHERE id IN (${placeholders})
          `,
          )
          .run(now, ...feedIds);
        for (const row of disabledRows) {
          enqueueFeedFetch(row.id, { force: true, now });
        }
        shouldWakePoller = disabledRows.length > 0;
        return result.changes;
      }

      if (action === 'disable') {
        return db
          .prepare(
            `UPDATE feeds SET enabled = 0, updated_at = ? WHERE id IN (${placeholders})`,
          )
          .run(now, ...feedIds).changes;
      }

      if (action === 'set_category') {
        return db
          .prepare(
            `UPDATE feeds SET category = ?, updated_at = ? WHERE id IN (${placeholders})`,
          )
          .run(nextCategory, now, ...feedIds).changes;
      }

      deleteJobsForFeeds(feedIds, db);
      return db
        .prepare(`DELETE FROM feeds WHERE id IN (${placeholders})`)
        .run(...feedIds).changes;
    })
    .immediate();

  if (shouldWakePoller) {
    wakePoller();
  }

  return Response.json({
    success: true,
    action,
    updated,
  });
};
