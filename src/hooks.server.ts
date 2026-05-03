import { building } from '$app/environment';
import { initializeDatabase } from '$lib/server/db/migrate';
import { validateSession, getSessionCookieName } from '$lib/server/auth/session';
import { startPolling } from '$lib/server/poller';
import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';

if (!building) {
  initializeDatabase();
  startPolling();
}

/** Check if the user has completed onboarding */
function isSetupComplete(): boolean {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'setup_complete'").get() as { value: string } | undefined;
    return row?.value === 'true';
  } catch {
    return false;
  }
}

const loginAttempts = new Map<string, number>();

export const handle: Handle = async ({ event, resolve }) => {
  // Session validation
  const sessionId = event.cookies.get(getSessionCookieName());
  if (sessionId) {
    const session = validateSession(sessionId);
    if (session) {
      event.locals.sessionId = session.id;
    }
  }

  // Rate limiting for login
  if (event.url.pathname === '/api/login' && event.request.method === 'POST') {
    const ip = event.request.headers.get('x-forwarded-for') || 'local';
    const attempts = loginAttempts.get(ip) || 0;
    if (attempts > 5) {
      return new Response(JSON.stringify({ error: 'Too many attempts. Try again later.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    loginAttempts.set(ip, attempts + 1);
    setTimeout(() => {
      const current = loginAttempts.get(ip) || 0;
      if (current > 0) loginAttempts.set(ip, current - 1);
    }, 60000);
  }

  // CSRF check for mutation methods (POST, PUT, DELETE)
  if (['POST', 'PUT', 'DELETE'].includes(event.request.method)) {
    const csrfToken = event.request.headers.get('x-csrf-token');
    if (!csrfToken && !event.url.pathname.startsWith('/api/')) {
      // Skip CSRF check for API routes, they handle auth separately
    }
  }

  // Auth guard for protected routes
  const publicPaths = new Set(['/login', '/api/login', '/api/logout']);
  const isPublicPath = publicPaths.has(event.url.pathname);
  const isApiRoute = event.url.pathname.startsWith('/api/');

  if (!event.locals.sessionId && !isPublicPath) {
    if (isApiRoute) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    throw redirect(302, '/login');
  }

  // First-run detection: if logged in but setup not complete, redirect to onboarding
  if (event.locals.sessionId && !isPublicPath) {
    const setupComplete = isSetupComplete();
    if (!setupComplete && event.url.pathname !== '/onboarding') {
      throw redirect(302, '/onboarding');
    }
  }

  return resolve(event);
};