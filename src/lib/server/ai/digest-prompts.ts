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

export const WEEKLY_DIGEST_PROMPT_MAX_ARTICLES = 60;
export const WEEKLY_DIGEST_PROMPT_MAX_CHARS = 24_000;

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
Use the complete article list supplied below, including read and unread items. The list may be a bounded sample of the eligible corpus; do not imply it covers articles that are not listed.
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
  eligibleArticleCount = articles.length,
): string {
  const eligibleCount = Number.isFinite(eligibleArticleCount)
    ? Math.max(0, Math.floor(eligibleArticleCount))
    : articles.length;
  const headerLines = (includedCount: number) => [
    `Window: ${windowStartLabel} to ${windowEndLabel}`,
    `Eligible articles in window: ${eligibleCount}`,
    `Articles included below: ${includedCount}`,
    '',
    `Article list. Use only these ${includedCount} IDs when selecting themes and stories:`,
  ];
  const footerLines = [
    '',
    'Organize the briefing as Top signal, Worth your time, and What changed. Focus on the main storylines and what a reader should know at a glance.',
    'Themes should group related articles across feeds, not just repeat feed names.',
    'Pick representative articles that cover the supplied list, not necessarily the highest score alone.',
    'Prefer unread or saved items for Worth your time, while still considering important read items.',
    'Distinguish new developments from ongoing coverage and surface uncertainty or disagreement when the metadata supports it.',
  ];
  const promptArticles: string[] = [];

  for (const article of articles.slice(0, WEEKLY_DIGEST_PROMPT_MAX_ARTICLES)) {
    const categoryText = formatList(article.categories);
    const flags = [
      article.read ? 'read' : 'unread',
      article.saved ? 'saved' : 'not_saved',
    ].join(', ');
    const line = [
      `- ID: ${article.id}`,
      `Title: ${clipText(article.title, 160)}`,
      `Feed: ${clipText(article.feedTitle, 60)}`,
      `Source: ${clipText(article.sourceUrl, 180)}`,
      `Published: ${article.publishedAtLabel}`,
      `Score: ${Math.round(article.score)}`,
      `Flags: ${flags}`,
      `Coverage cluster: ${article.clusterId} (${article.clusterSize} related item${article.clusterSize === 1 ? '' : 's'})`,
      article.relatedArticleIds.length > 1
        ? `Related IDs: ${article.relatedArticleIds.slice(0, 4).join(', ')}`
        : '',
      categoryText ? `Categories: ${clipText(categoryText, 100)}` : '',
      article.summary ? `Summary: ${clipText(article.summary, 180)}` : '',
    ]
      .filter(Boolean)
      .join(' | ');
    const candidate = [
      ...headerLines(promptArticles.length + 1),
      ...promptArticles,
      line,
      ...footerLines,
    ].join('\n');
    if (candidate.length > WEEKLY_DIGEST_PROMPT_MAX_CHARS) break;
    promptArticles.push(line);
  }

  return [
    ...headerLines(promptArticles.length),
    ...promptArticles,
    ...footerLines,
  ].join('\n');
}
