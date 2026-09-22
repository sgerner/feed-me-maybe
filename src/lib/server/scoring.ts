import { getDb } from '$lib/server/db';

/**
 * Jev is the personalized semantic signal. The existing heuristic remains
 * important for explicit actions, while the article LLM stays responsible for
 * enrichment and quality/novelty metadata.
 */
export const JEV_SCORE_WEIGHT = 0.7;
export const HEURISTIC_SCORE_WEIGHT = 0.2;
export const ARTICLE_AI_SCORE_WEIGHT = 0.1;

export type ScoreSignals = {
  heuristic: number;
  aiComposite: number;
  jevScore: number | null;
  hasAiAnalysis: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Convert the independent signals to the stored 0-100 ranking score.
 *
 * Without Jev this intentionally preserves the legacy formula, so a missing
 * Jev credential or transient Jev outage degrades safely instead of changing
 * the behavior of the existing LLM-only path.
 */
export function calculateCombinedScore(signals: ScoreSignals): number | null {
  const heuristic = clamp(Number(signals.heuristic) || 0, 0, 100);
  const aiComposite = clamp(Number(signals.aiComposite) || 0, 0, 1);

  if (signals.jevScore != null && Number.isFinite(signals.jevScore)) {
    // A neutral article-AI value keeps Jev-only articles on the same scale
    // while their traditional LLM enrichment is still pending.
    const articleAi = signals.hasAiAnalysis ? aiComposite : 0.5;
    return Math.round(
      clamp(
        signals.jevScore * 100 * JEV_SCORE_WEIGHT +
          heuristic * HEURISTIC_SCORE_WEIGHT +
          articleAi * 100 * ARTICLE_AI_SCORE_WEIGHT,
        0,
        100,
      ),
    );
  }

  if (!signals.hasAiAnalysis) return null;
  return Math.round(clamp(heuristic * 0.6 + aiComposite * 100 * 0.4, 0, 100));
}

/** Recompute the active ranking score after either model or user-state data changes. */
export function refreshCombinedScore(articleId: string): number | null {
  const db = getDb();
  const row = db
    .prepare(
      `
        SELECT a.heuristic_score, a.jev_score,
               CASE WHEN am.analysis_status = 'ready' THEN 1 ELSE 0 END AS has_ai_analysis,
               COALESCE(am.ai_relevance_score, 0) AS ai_relevance_score,
               COALESCE(am.quality_score, 0) AS quality_score,
               COALESCE(am.novelty_score, 0) AS novelty_score
        FROM articles a
        LEFT JOIN article_ai_metadata am ON am.article_id = a.id
        WHERE a.id = ?
      `,
    )
    .get(articleId) as
    | {
        heuristic_score: number | null;
        jev_score: number | null;
        has_ai_analysis: number;
        ai_relevance_score: number;
        quality_score: number;
        novelty_score: number;
      }
    | undefined;

  if (!row) return null;

  const aiComposite =
    Number(row.ai_relevance_score || 0) * 0.7 +
    Number(row.quality_score || 0) * 0.2 +
    Number(row.novelty_score || 0) * 0.1;
  const combined = calculateCombinedScore({
    heuristic: Number(row.heuristic_score ?? 50),
    aiComposite,
    jevScore:
      row.jev_score == null || !Number.isFinite(Number(row.jev_score))
        ? null
        : Number(row.jev_score),
    hasAiAnalysis: row.has_ai_analysis === 1,
  });

  db.prepare('UPDATE articles SET combined_score = ? WHERE id = ?').run(
    combined,
    articleId,
  );
  return combined;
}
