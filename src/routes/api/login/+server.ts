import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyPassword } from '$lib/server/auth/password';
import {
  createSession,
  setSessionCookie,
  getSessionCookieName,
} from '$lib/server/auth/session';
import {
  consumeLoginAttempt,
  getClientAddress as getSafeClientAddress,
  resetLoginAttempts,
} from '$lib/server/auth/rate-limit';

export const POST: RequestHandler = async ({
  request,
  cookies,
  getClientAddress,
}) => {
  const address = getSafeClientAddress(getClientAddress);
  const rate = consumeLoginAttempt(address);
  if (!rate.allowed) {
    return json(
      { error: 'Too many attempts. Try again later.' },
      {
        status: 429,
        headers: {
          'Cache-Control': 'no-store',
          'Retry-After': String(rate.retryAfterSeconds || 300),
        },
      },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { password } = body;

  if (!password || typeof password !== 'string') {
    return json({ error: 'Password is required' }, { status: 400 });
  }

  if (!verifyPassword(password)) {
    return json({ error: 'Invalid password' }, { status: 401 });
  }

  const session = createSession();
  resetLoginAttempts(getSafeClientAddress(getClientAddress));
  const cookieHeader = setSessionCookie(session.id);

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': cookieHeader,
    },
  });
};
