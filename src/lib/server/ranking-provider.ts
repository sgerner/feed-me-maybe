import { getDb } from '$lib/server/db';

export const RANKING_PROVIDERS = ['jev', 'subq'] as const;
export type RankingProvider = (typeof RANKING_PROVIDERS)[number];

export const RANKING_PROVIDER_SETTING = 'ranking_provider';
export const RANKING_PROVIDER_REVISION_SETTING = 'ranking_provider_revision';

export function isRankingProvider(value: unknown): value is RankingProvider {
  return RANKING_PROVIDERS.includes(value as RankingProvider);
}

function parseRevision(value: string | null | undefined): number {
  const revision = Number(value || 0);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

/** Read provider and revision in one SQLite snapshot for stale-result guards. */
export function getRankingProviderSnapshot(): {
  provider: RankingProvider;
  revision: number;
} {
  const row = getDb()
    .prepare(
      `SELECT
         (SELECT value FROM app_settings WHERE key = ?) AS provider,
         (SELECT value FROM app_settings WHERE key = ?) AS revision`,
    )
    .get(RANKING_PROVIDER_SETTING, RANKING_PROVIDER_REVISION_SETTING) as
    { provider: string | null; revision: string | null } | undefined;

  return {
    provider: isRankingProvider(row?.provider) ? row.provider : 'jev',
    revision: parseRevision(row?.revision),
  };
}

export function getRankingProvider(): RankingProvider {
  return getRankingProviderSnapshot().provider;
}

export function advanceRankingProviderRevision(now = Date.now()): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, '1', ?)
     ON CONFLICT(key) DO UPDATE SET
       value = CAST(COALESCE(value, '0') AS INTEGER) + 1,
       updated_at = excluded.updated_at`,
  ).run(RANKING_PROVIDER_REVISION_SETTING, now);
  return getRankingProviderSnapshot().revision;
}
