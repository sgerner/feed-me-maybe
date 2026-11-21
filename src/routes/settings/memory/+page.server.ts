import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getDecayedStrength } from '$lib/server/preferences';

type PreferenceMemoryRow = {
  id: string;
  label: string;
  type: string;
  polarity: 'positive' | 'negative';
  strength: number;
  evidence_count: number;
  last_reinforced: number;
  explanation: string;
  created_at: number;
};

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) return {};
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM user_preference_memory')
    .all() as PreferenceMemoryRow[];
  const preferences = rows
    .map((row) => ({
      ...row,
      strength: getDecayedStrength(
        Number(row.strength || 0),
        Number(row.last_reinforced || 0),
      ),
    }))
    .sort((a, b) => b.strength - a.strength);
  return { preferences };
};
