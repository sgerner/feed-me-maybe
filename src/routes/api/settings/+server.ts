import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { applySettingsMutation } from '$lib/server/settings';
import { initializeDatabase } from '$lib/server/db/migrate';

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

  const { key, value } = body;

  if (!key || typeof key !== 'string' || typeof value !== 'string') {
    return json(
      { error: 'key and value (strings) are required' },
      { status: 400 },
    );
  }

  // Ensure schema is present for explicit mutation paths in fresh environments.
  initializeDatabase();
  const result = applySettingsMutation(key, value);
  return json(result, { status: result.success ? 200 : 400 });
};
