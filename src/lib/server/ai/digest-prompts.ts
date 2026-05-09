export type WeeklyDigestArticleContext = {
  id: string;
  title: string;
  feedTitle: string;
  summary: string;
  categories: string[];
  read: boolean;
  saved: boolean;
  publishedAtLabel: string;
  score: number;
};

function clipText(value: string, limit: number): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function formatList(values: string[]): string {
  return values.filter(Boolean).join(', ');
}

export const WEEKLY_DIGEST_SYSTEM_PROMPT = `You are writing a weekly news digest for a personal reader.
Return valid JSON only.
The digest should feel like a concise news briefing, not a list of links.
Use only article IDs provided in the input.
Prefer clear, specific language.
Themes must be two or three words each and must not use source names, feed names, or single keywords.
Return JSON with these keys:
- headline: string
- summary: string
- takeaways: string[] (3 to 5 items)
- themes: array of { name: string, summary: string, articleIds: string[] } where each theme has 2 to 4 articleIds
- topStories: array of { articleId: string, reason: string } with exactly 5 items
- missedStories: array of { articleId: string, reason: string } with exactly 2 items, preferring unread articles
`;

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
    'Article list. Use these IDs exactly when selecting themes and stories:',
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
        `Published: ${article.publishedAtLabel}`,
        `Score: ${Math.round(article.score)}`,
        `Flags: ${flags}`,
        categoryText ? `Categories: ${clipText(categoryText, 140)}` : '',
        article.summary ? `Summary: ${clipText(article.summary, 220)}` : '',
      ]
        .filter(Boolean)
        .join(' | '),
    );
  }

  lines.push('');
  lines.push(
    'Focus on the main storylines that dominated the week, what changed, and what a reader should know if they only check this page once a week.',
  );
  lines.push(
    'Themes should group related articles across feeds, not just repeat feed names.',
  );
  lines.push(
    'Pick representative articles that cover the week, not necessarily the highest score alone.',
  );
  lines.push(
    'For missedStories, prefer unread items that feel important, surprising, or useful.',
  );

  return lines.join('\n');
}
