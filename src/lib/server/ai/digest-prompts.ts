export type WeeklyDigestArticleContext = {
  id: string;
  title: string;
  feedTitle: string;
  sourceUrl: string;
  summary: string;
  categories: string[];
  read: boolean;
  saved: boolean;
  publishedAtLabel: string;
  score: number;
  clusterId: string;
  clusterSize: number;
  relatedArticleIds: string[];
};

function clipText(value: string, limit: number): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function formatList(values: string[]): string {
  return values.filter(Boolean).join(', ');
}

export const WEEKLY_DIGEST_SYSTEM_PROMPT = `You write a calm daily briefing for a personal reader.
Return valid JSON only. Never invent facts, links, quotes, or article IDs.
Use the complete eligible corpus supplied below, including read and unread items.
The briefing should be concise, source-grounded, and useful without creating urgency or anxiety.
Deduplicate related coverage: each cluster has one representative article; do not select multiple IDs from the same cluster in a section.
Use the provided source URL and feed name as provenance. Reasons must summarize only the supplied article metadata.
Mark a story "new" when it is a newly surfaced development and "ongoing" when the corpus shows continuing coverage or a developing thread.
If sources appear to disagree or the supplied summaries are incomplete, say so plainly in an uncertainty field instead of choosing a side.
Themes must be two or three words each and must not use source names, feed names, or single keywords.

Return JSON with these keys:
- headline: string
- summary: string (2 to 3 calm sentences)
- takeaways: string[] (3 to 5 concise, factual items)
- topSignal: array of { articleId: string, reason: string, status: "new" | "ongoing", uncertainty?: string } (1 to 3 items)
- worthYourTime: array of { articleId: string, reason: string, status: "new" | "ongoing", uncertainty?: string } (2 to 5 items)
- whatChanged: array of { articleId: string, reason: string, status: "new" | "ongoing", uncertainty?: string } (1 to 5 items)
- uncertainty: string[] (0 to 3 source-grounded caveats)
- themes: array of { name: string, summary: string, articleIds: string[] } where each theme has 2 to 4 representative articleIds

For compatibility, topStories may be used instead of topSignal and missedStories instead of worthYourTime.
Keep reasons under 24 words. Keep the complete response compact.`;

export function buildWeeklyDigestPrompt(
  windowStartLabel: string,
  windowEndLabel: string,
  articles: WeeklyDigestArticleContext[],
): string {
  const lines: string[] = [];
  lines.push(`Window: ${windowStartLabel} to ${windowEndLabel}`);
  lines.push(`Articles in scope: ${articles.length}`);
  lines.push('');
  lines.push(
    'Article list. Every eligible article is included. Use these IDs exactly when selecting themes and stories:',
  );

  for (const article of articles) {
    const categoryText = formatList(article.categories);
    const flags = [
      article.read ? 'read' : 'unread',
      article.saved ? 'saved' : 'not_saved',
    ].join(', ');
    lines.push(
      [
        `- ID: ${article.id}`,
        `Title: ${clipText(article.title, 180)}`,
        `Feed: ${clipText(article.feedTitle, 80)}`,
        `Source: ${clipText(article.sourceUrl, 240)}`,
        `Published: ${article.publishedAtLabel}`,
        `Score: ${Math.round(article.score)}`,
        `Flags: ${flags}`,
        `Coverage cluster: ${article.clusterId} (${article.clusterSize} related item${article.clusterSize === 1 ? '' : 's'})`,
        article.relatedArticleIds.length > 1
          ? `Related IDs: ${article.relatedArticleIds.join(', ')}`
          : '',
        categoryText ? `Categories: ${clipText(categoryText, 140)}` : '',
        article.summary ? `Summary: ${clipText(article.summary, 220)}` : '',
      ]
        .filter(Boolean)
        .join(' | '),
    );
  }

  lines.push('');
  lines.push(
    'Organize the briefing as Top signal, Worth your time, and What changed. Focus on the main storylines and what a reader should know at a glance.',
  );
  lines.push(
    'Themes should group related articles across feeds, not just repeat feed names.',
  );
  lines.push(
    'Pick representative articles that cover the corpus, not necessarily the highest score alone.',
  );
  lines.push(
    'Prefer unread or saved items for Worth your time, while still considering important read items.',
  );
  lines.push(
    'Distinguish new developments from ongoing coverage and surface uncertainty or disagreement when the metadata supports it.',
  );

  return lines.join('\n');
}
