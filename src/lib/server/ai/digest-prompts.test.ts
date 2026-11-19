import { describe, expect, it } from 'vitest';
import {
  buildWeeklyDigestPrompt,
  WEEKLY_DIGEST_PROMPT_MAX_ARTICLES,
  WEEKLY_DIGEST_PROMPT_MAX_CHARS,
  WEEKLY_DIGEST_SYSTEM_PROMPT,
} from './digest-prompts';

describe('calm daily briefing prompt', () => {
  it('includes every corpus item, source provenance, and dedupe metadata', () => {
    const prompt = buildWeeklyDigestPrompt('Sep 1', 'Sep 7', [
      {
        id: 'read-hidden',
        title: 'A read article',
        feedTitle: 'Example Feed',
        sourceUrl: 'https://example.com/article',
        summary: 'A grounded summary.',
        categories: ['technology'],
        read: true,
        saved: false,
        publishedAtLabel: 'Sep 4',
        score: 80,
        clusterId: 'read-hidden',
        clusterSize: 2,
        relatedArticleIds: ['read-hidden', 'related'],
      },
      {
        id: 'unread',
        title: 'An unread article',
        feedTitle: 'Second Feed',
        sourceUrl: 'https://second.example/article',
        summary: '',
        categories: [],
        read: false,
        saved: true,
        publishedAtLabel: 'Sep 5',
        score: 60,
        clusterId: 'unread',
        clusterSize: 1,
        relatedArticleIds: ['unread'],
      },
    ]);

    expect(prompt).toContain('Eligible articles in window: 2');
    expect(prompt).toContain('Articles included below: 2');
    expect(prompt).toContain('ID: read-hidden');
    expect(prompt).toContain('ID: unread');
    expect(prompt).toContain('Source: https://example.com/article');
    expect(prompt).toContain('Related IDs: read-hidden, related');
    expect(WEEKLY_DIGEST_SYSTEM_PROMPT).toContain('bounded sample');
    expect(WEEKLY_DIGEST_SYSTEM_PROMPT).toContain('uncertainty');
    expect(WEEKLY_DIGEST_SYSTEM_PROMPT).toContain('topSignal');
  });

  it('bounds the article count and total prompt characters', () => {
    const articles = Array.from({ length: 1_500 }, (_, index) => ({
      id: `article-${index}`,
      title: `Article ${index} ${'title '.repeat(80)}`,
      feedTitle: `Feed ${index}`,
      sourceUrl: `https://example.com/${index}`,
      summary: 'A detailed summary. '.repeat(40),
      categories: ['technology', 'science'],
      read: false,
      saved: false,
      publishedAtLabel: 'Nov 18',
      score: 100 - index,
      clusterId: `article-${index}`,
      clusterSize: 1,
      relatedArticleIds: [`article-${index}`],
    }));

    const prompt = buildWeeklyDigestPrompt('Nov 11', 'Nov 18', articles);
    const articleRows = prompt
      .split('\n')
      .filter((line) => line.startsWith('- ID: '));

    expect(prompt.length).toBeLessThanOrEqual(WEEKLY_DIGEST_PROMPT_MAX_CHARS);
    expect(articleRows.length).toBeLessThanOrEqual(
      WEEKLY_DIGEST_PROMPT_MAX_ARTICLES,
    );
    expect(prompt).toContain('Eligible articles in window: 1500');
    expect(prompt).toContain(`Articles included below: ${articleRows.length}`);
  });
});
