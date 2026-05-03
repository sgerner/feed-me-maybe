import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  destroySession,
  clearSessionCookie,
  getSessionCookieName,
} from '$lib/server/auth/session';

export const POST: RequestHandler = async ({ cookies }) => {
  const sessionId = cookies.get(getSessionCookieName());

  if (sessionId) {
    destroySession(sessionId);
  }

  const cookieHeader = clearSessionCookie();

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookieHeader,
    },
  });
};
