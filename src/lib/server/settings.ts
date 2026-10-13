import { getDb } from '$lib/server/db';
import {
  advanceRankingProviderRevision,
  getRankingProviderSnapshot,
  isRankingProvider,
} from '$lib/server/ranking-provider';
import { isRankingProviderConfigured } from '$lib/server/ai/jev';
import { refreshCombinedScore } from '$lib/server/scoring';
import { getRankingFeedbackRevision } from '$lib/server/ranking-freshness';

function updateRankingProvider(value: string): {
  success: boolean;
  message?: string;
  provider?: string;
  configured?: boolean;
  changed?: boolean;
} {
  if (!isRankingProvider(value)) {
    return { success: false, message: 'Invalid ranking provider' };
  }

  const db = getDb();
  const now = Date.now();
  const changed = db
    .transaction(() => {
      const currentProvider = getRankingProviderSnapshot().provider;
      if (currentProvider === value) return false;

      db.prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ('ranking_provider', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at`,
      ).run(value, now);
      advanceRankingProviderRevision(now);

      // The legacy jev_score column stores whichever selected provider is
      // active. Clear it before recomputing the fallback ranking so a score
      // from the old model is never reused under the new selection.
      db.prepare(
        `UPDATE articles
         SET jev_score = NULL, jev_processed_at = NULL, jev_error = ''`,
      ).run();
      db.prepare('DELETE FROM ranking_refresh_queue').run();
      db.prepare(
        "DELETE FROM jobs WHERE type = 'jev_process' AND status = 'queued'",
      ).run();

      const revision = getRankingFeedbackRevision();
      const articleIds = db.prepare('SELECT id FROM articles').all() as Array<{
        id: string;
      }>;
      const queueRefresh = db.prepare(
        `INSERT INTO ranking_refresh_queue
           (article_id, requested_revision, heuristic_revision, not_before, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const { id } of articleIds) {
        queueRefresh.run(id, revision, revision, now, now);
        refreshCombinedScore(id);
      }

      return true;
    })
    .immediate();

  return {
    success: true,
    provider: value,
    configured: isRankingProviderConfigured(value),
    changed,
    message: changed
      ? 'Ranking provider updated; article scores are being recalculated'
      : 'Ranking provider is already selected',
  };
}

export function applySettingsMutation(
  key: string,
  value: string,
): {
  success: boolean;
  message?: string;
  provider?: string;
  configured?: boolean;
  changed?: boolean;
} {
  const db = getDb();

  if (key === 'ranking_provider') return updateRankingProvider(value);

  if (key === 'reset_training' && value === 'true') {
    db.prepare('DELETE FROM user_interactions').run();
    db.prepare('DELETE FROM user_preference_memory').run();
    db.prepare('DELETE FROM article_ai_metadata').run();
    db.prepare(
      "UPDATE articles SET hidden = 0, read = 0, saved = 0, thumbs_up = 0, thumbs_down = 0, heuristic_score = 50, jev_score = NULL, jev_processed_at = NULL, jev_error = '', combined_score = 0",
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
