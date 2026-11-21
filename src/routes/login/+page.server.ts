import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { verifyPassword } from '#lib/server/auth/password.ts';
import {
  createSession,
  getSessionCookieName,
  SESSION_MAX_AGE_MS,
  validateSession,
} from '#lib/server/auth/session.ts';
import {
  consumeLoginAttempt,
  getClientAddress as getSafeClientAddress,
  resetLoginAttempts,
} from '#lib/server/auth/rate-limit.ts';
import { safeReturnTo } from '#lib/server/auth/redirect.ts';

export const load: PageServerLoad = async ({ cookies, url }) => {
  const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
  const sessionId = cookies.get(getSessionCookieName());
  if (sessionId && validateSession(sessionId)) {
    throw redirect(302, returnTo);
  }
  return { returnTo };
};

export const actions: Actions = {
  default: async ({ request, cookies, getClientAddress, url }) => {
    const address = getSafeClientAddress(getClientAddress);
    const rate = consumeLoginAttempt(address);
    if (!rate.allowed) {
      return fail(429, {
        error: 'Too many attempts. Try again later.',
        field: 'form',
        retryAfterSeconds: rate.retryAfterSeconds || 300,
      });
    }

    const data = await request.formData();
    const password = data.get('password');

    if (typeof password !== 'string' || password.length === 0) {
      return fail(400, { error: 'Password is required', field: 'password' });
    }

    if (!verifyPassword(password)) {
      return fail(401, { error: 'Invalid password', field: 'password' });
    }

    const session = createSession();
    resetLoginAttempts(getSafeClientAddress(getClientAddress));
    cookies.set(getSessionCookieName(), session.id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE_MS / 1000,
      secure: process.env.NODE_ENV === 'production',
    });

    const formReturnTo = data.get('returnTo');
    const returnTo = safeReturnTo(
      typeof formReturnTo === 'string'
        ? formReturnTo
        : url.searchParams.get('returnTo'),
    );
    throw redirect(303, returnTo);
  },
};
