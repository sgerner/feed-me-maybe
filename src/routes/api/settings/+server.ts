import type { RequestHandler } from './$types';
import { readJsonObject } from '#lib/server/request-body.ts';
import { applySettingsMutation } from '#lib/server/settings.ts';
import { initializeDatabase } from '#lib/server/db/migrate.ts';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await readJsonObject(request);
  if (!body) {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { key, value } = body;

  if (!key || typeof key !== 'string' || typeof value !== 'string') {
    return Response.json(
      { error: 'key and value (strings) are required' },
      { status: 400 },
    );
  }

  // Ensure schema is present for explicit mutation paths in fresh environments.
  initializeDatabase();
  const result = applySettingsMutation(key, value);
  return Response.json(result, { status: result.success ? 200 : 400 });
};
