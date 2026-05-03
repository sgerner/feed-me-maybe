import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { verifyPassword } from '$lib/server/auth/password';
import {
  createSession,
  getSessionCookieName,
  SESSION_MAX_AGE_MS,
  validateSession,
} from '$lib/server/auth/session';

export const load: PageServerLoad = async ({ cookies }) => {
  const sessionId = cookies.get(getSessionCookieName());
  if (sessionId && validateSession(sessionId)) {
    throw redirect(302, '/');
  }
  return {};
};

export const actions: Actions = {
  default: async ({ request, cookies }) => {
    const data = await request.formData();
    const password = data.get('password');

    if (typeof password !== 'string' || password.length === 0) {
      return fail(400, { error: 'Password is required' });
    }

    if (!verifyPassword(password)) {
      return fail(401, { error: 'Invalid password' });
    }

    const session = createSession();
    cookies.set(getSessionCookieName(), session.id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE_MS / 1000,
      secure: process.env.NODE_ENV === 'production',
    });

    throw redirect(303, '/');
  },
};
