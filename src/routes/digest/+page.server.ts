import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { createEmptyDigest } from '#lib/digest-types.ts';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.sessionId) {
    throw error(401, 'Unauthorized');
  }

  return createEmptyDigest();
};
