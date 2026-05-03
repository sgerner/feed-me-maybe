import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import crypto from 'node:crypto';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.sessionId) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const rows = db
    .prepare(
      'SELECT id, url, title, description, site_url, category, icon_url, enabled, error_count, last_fetch_status, last_fetch_at, last_error, created_at, updated_at FROM feeds ORDER BY title ASC',
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

  const { url, title, category } = body;

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

  try {
    db.prepare(
      'INSERT INTO feeds (id, url, title, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, url, title || '', category || '', now.getTime(), now.getTime());
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
