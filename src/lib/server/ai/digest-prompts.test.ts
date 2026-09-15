import { describe, expect, it } from 'vitest';
import {
  buildWeeklyDigestPrompt,
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

    expect(prompt).toContain('Articles in scope: 2');
    expect(prompt).toContain('ID: read-hidden');
    expect(prompt).toContain('ID: unread');
    expect(prompt).toContain('Source: https://example.com/article');
    expect(prompt).toContain('Related IDs: read-hidden, related');
    expect(WEEKLY_DIGEST_SYSTEM_PROMPT).toContain('complete eligible corpus');
    expect(WEEKLY_DIGEST_SYSTEM_PROMPT).toContain('uncertainty');
    expect(WEEKLY_DIGEST_SYSTEM_PROMPT).toContain('topSignal');
  });
});
