import { getDb } from '$lib/server/db';

export function applySettingsMutation(
  key: string,
  value: string,
): { success: boolean; message?: string } {
  const db = getDb();

  if (key === 'reset_training' && value === 'true') {
    db.prepare('DELETE FROM user_interactions').run();
    db.prepare('DELETE FROM user_preference_memory').run();
    db.prepare('DELETE FROM article_ai_metadata').run();
    db.prepare(
      'UPDATE articles SET hidden = 0, read = 0, saved = 0, thumbs_up = 0, thumbs_down = 0, heuristic_score = 50, combined_score = 0',
    ).run();
    return { success: true, message: 'Training data reset' };
  }

  if (key.startsWith('delete_pref_') && value === 'true') {
    const prefId = key.slice('delete_pref_'.length);
    if (!prefId) return { success: false, message: 'Preference id missing' };
    db.prepare('DELETE FROM user_preference_memory WHERE id = ?').run(prefId);
    return { success: true, message: 'Preference deleted' };
  }

  db.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, value, Date.now());
  return { success: true };
}
