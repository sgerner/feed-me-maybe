import type { PageServerLoad, Actions } from './$types';
import { getDb } from '$lib/server/db';
import { fail } from '@sveltejs/kit';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) return {};

  const db = getDb();
  const pollInterval = db.prepare("SELECT value FROM app_settings WHERE key = 'poll_interval_mins'").get() as { value: string } | undefined;

  return { 
    pollInterval: parseInt(pollInterval?.value || '15', 10)
  };
};

export const actions: Actions = {
  updatePolling: async ({ request, locals }) => {
    if (!locals.sessionId) return fail(401);

    const data = await request.formData();
    const interval = data.get('interval');

    if (!interval || isNaN(Number(interval))) {
      return fail(400, { error: 'Invalid interval' });
    }

    const intervalVal = Math.max(1, Math.min(1440, Number(interval))); // 1 min to 24 hours

    const db = getDb();
    db.prepare("UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'poll_interval_mins'")
      .run(String(intervalVal), Date.now());

    return { success: true };
  }
};
