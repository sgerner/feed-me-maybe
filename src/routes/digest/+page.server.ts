import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) {
    throw error(401, 'Unauthorized');
  }

  return {
    headline: 'Weekly Digest',
    summary: '',
    takeaways: [],
    themes: [],
    topStories: [],
    missedStories: [],
    activeFeeds: [],
    totalArticles: 0,
    totalFeeds: 0,
    unreadArticles: 0,
    savedArticles: 0,
    windowStart: Date.now(),
    windowEnd: Date.now(),
    generatedAt: Date.now(),
    cacheHit: false,
  };
};
