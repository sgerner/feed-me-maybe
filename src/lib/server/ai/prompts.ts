import type { ArticleAnalysisInput } from './types';

const SIGNAL_TAGS = [
  'official_announcement',
  'primary_source',
  'specific_details',
  'technical_depth',
  'data_driven',
  'actionable',
  'hands_on',
  'concrete_update',
  'cited_sources',
  'speculation',
  'rumor',
  'leak',
  'hype',
  'clickbait',
  'seo_filler',
  'opinion_only',
  'future_guessing',
  'thin_rewrite',
  'ad_copy',
];

const MAX_TITLE_CHARS = 240;
const MAX_META_CHARS = 160;
const MAX_SUMMARY_CHARS = 520;
const MAX_CONTENT_CHARS = 1600;

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#038;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipText(value: string, limit: number): string {
  const text = stripHtml(value);
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function joinList(values: string[] | undefined, limit: number): string {
  const items = (values || [])
    .map((value) => clipText(String(value), MAX_META_CHARS))
    .filter(Boolean)
    .slice(0, limit);
  return items.join(', ');
}

export const ARTICLE_ANALYSIS_SYSTEM_PROMPT = `You are an article classifier for a personal reader.
Return valid JSON only.
Prefer factual, evidence-backed, specific, and useful content.
Score relevance, novelty, and quality from 0 to 1.
LikelyUserInterest must be high, medium, or low.
Quality should reflect factual grounding, specificity, and usefulness.
Topics and entities should be short arrays of the most relevant items.
Choose up to 6 neutral signals from this list:
${SIGNAL_TAGS.join(', ')}
Signals are descriptive labels, not user preferences.
Use contentType values such as news, tutorial, opinion, analysis, release_note, review, interview, announcement, podcast, video, essay, other.
Return JSON keys: summary, topics, entities, contentType, relevanceScore, noveltyScore, qualityScore, likelyUserInterest, signals, explanation.`;

export function buildArticleAnalysisPrompt(
  article: ArticleAnalysisInput,
): string {
  const lines: string[] = [];

  if (article.title) {
    lines.push(`Title: ${clipText(article.title, MAX_TITLE_CHARS)}`);
  }
  if (article.author) {
    lines.push(`Author: ${clipText(article.author, MAX_META_CHARS)}`);
  }
  if (article.publishedAge) {
    lines.push(`Age: ${clipText(article.publishedAge, 32)}`);
  }
  if (article.categories?.length) {
    lines.push(`Categories: ${joinList(article.categories, 6)}`);
  }
  if (article.summary) {
    lines.push(`Summary: ${clipText(article.summary, MAX_SUMMARY_CHARS)}`);
  }
  if (article.content) {
    lines.push(`Content: ${clipText(article.content, MAX_CONTENT_CHARS)}`);
  }

  lines.push(
    'Focus on ranking signals that separate high-value reporting from speculation or fluff.',
  );

  return lines.join('\n');
}
