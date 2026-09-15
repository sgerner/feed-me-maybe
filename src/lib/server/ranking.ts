/**
 * Ranking expressions shared by the reading list, inbox, feed view, and API.
 *
 * A zero combined score is the legacy representation for "AI has not
 * produced a score yet". Treating it as a real score made healthy heuristic
 * articles disappear below every analyzed article. Freshness and a capped
 * per-feed penalty keep the list useful without allowing one prolific feed to
 * occupy the entire first page.
 */
export function effectiveScoreExpression(alias = 'a'): string {
  return `COALESCE(NULLIF(${alias}.combined_score, 0), ${alias}.heuristic_score, 0)`;
}

function articleAgeDaysExpression(alias = 'a'): string {
  return `(MAX(0.0, (strftime('%s', 'now') * 1000 - COALESCE(${alias}.published_at, ${alias}.fetched_at)) / 86400000.0))`;
}

export function rankingScoreExpression(alias = 'a'): string {
  const effective = effectiveScoreExpression(alias);
  const ageDays = articleAgeDaysExpression(alias);
  const recentBoost = `CASE
    WHEN COALESCE(${alias}.published_at, ${alias}.fetched_at) >= strftime('%s', 'now') * 1000 - 86400000 THEN 8
    WHEN COALESCE(${alias}.published_at, ${alias}.fetched_at) >= strftime('%s', 'now') * 1000 - 259200000 THEN 4
    WHEN COALESCE(${alias}.published_at, ${alias}.fetched_at) >= strftime('%s', 'now') * 1000 - 604800000 THEN 2
    ELSE 0
  END`;
  const agePenalty = `MIN(${ageDays} / 45.0, 10.0)`;
  return `(${effective} + ${recentBoost} - ${agePenalty})`;
}

const ARTICLE_COLUMNS = `
  a.id, a.feed_id, a.url, a.title, a.author, a.summary, a.image_url, a.categories,
  a.published_at, a.fetched_at, a.read, a.saved, a.hidden, a.thumbs_up, a.thumbs_down,
  a.heuristic_score, a.combined_score,
  f.title as feed_title, f.url as feed_url, f.open_mode as feed_open_mode
`;

/**
 * Build the cross-feed query used by the main reading surfaces. The where
 * clause is assembled only from server-owned SQL fragments; values still go
 * through the caller's bound parameters.
 */
export function buildGlobalArticleRankingQuery(whereClause: string): string {
  const score = rankingScoreExpression('a');
  return `
    WITH ranked_articles AS (
      SELECT ${ARTICLE_COLUMNS},
             ${score} AS rank_score,
             ROW_NUMBER() OVER (
               PARTITION BY a.feed_id
               ORDER BY ${score} DESC,
                        COALESCE(a.published_at, a.fetched_at) DESC,
                        a.id DESC
             ) AS feed_rank
      FROM articles a
      JOIN feeds f ON f.id = a.feed_id
      WHERE ${whereClause}
    )
    SELECT id, feed_id, url, title, author, summary, image_url, categories,
           published_at, fetched_at, read, saved, hidden, thumbs_up, thumbs_down,
           heuristic_score, combined_score, feed_title, feed_url, feed_open_mode
    FROM ranked_articles
    ORDER BY rank_score - MIN((feed_rank - 1) * 2.5, 15) DESC,
             COALESCE(published_at, fetched_at) DESC,
             id DESC
  `;
}

export const rankingOrderExpression = rankingScoreExpression;
