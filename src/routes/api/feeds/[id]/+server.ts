import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { isArticleOpenMode } from '$lib/constants/article-open-modes';

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(params.id);

  if (!feed) {
    return json({ error: 'Feed not found' }, { status: 404 });
  }

  return json({ feed });
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM feeds WHERE id = ?')
    .get(params.id);
  if (!existing) {
    return json({ error: 'Feed not found' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Build update SET clause dynamically
  const allowedFields = ['title', 'category', 'enabled', 'open_mode', 'use_proxy'];
  const updates: string[] = [];
  const values: (string | number | boolean | null)[] = [];

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      if (field === 'enabled' && typeof body[field] !== 'boolean') {
        return json({ error: 'enabled must be a boolean' }, { status: 400 });
      }
      if (field === 'use_proxy' && typeof body[field] !== 'boolean') {
        return json({ error: 'use_proxy must be a boolean' }, { status: 400 });
      }
      if (field === 'open_mode' && body[field] !== null && !isArticleOpenMode(body[field])) {
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

  if (updates.length === 0) {
    return json({ error: 'No valid fields to update' }, { status: 400 });
  }

  updates.push('updated_at = ?');
  values.push(Date.now());
  values.push(params.id);

  try {
    db.prepare(`UPDATE feeds SET ${updates.join(', ')} WHERE id = ?`).run(
      ...values,
    );
  } catch {
    return json({ error: 'Failed to update feed' }, { status: 500 });
  }

  const feed = db.prepare('SELECT * FROM feeds WHERE id = ?').get(params.id);
  return json({ feed });
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
