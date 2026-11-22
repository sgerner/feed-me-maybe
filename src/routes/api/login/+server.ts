import type { RequestHandler } from './$types';
import { verifyPassword } from '#lib/server/auth/password.ts';
import { createSession, setSessionCookie } from '#lib/server/auth/session.ts';
import {
  consumeLoginAttempt,
  getClientAddress as getSafeClientAddress,
  resetLoginAttempts,
} from '#lib/server/auth/rate-limit.ts';

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const address = getSafeClientAddress(getClientAddress);
  const rate = consumeLoginAttempt(address);
  if (!rate.allowed) {
    return Response.json(
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
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { password } = body;

  if (!password || typeof password !== 'string') {
    return Response.json({ error: 'Password is required' }, { status: 400 });
  }

  if (!verifyPassword(password)) {
    return Response.json({ error: 'Invalid password' }, { status: 401 });
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
