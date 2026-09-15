import { building } from '$app/environment';
import { initializeDatabase } from '$lib/server/db/migrate';
import {
  validateSession,
  getSessionCookieName,
} from '$lib/server/auth/session';
import { startPolling } from '$lib/server/poller';
import type { Handle, HandleServerError } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { recordAppError } from '$lib/server/logging';
import {
  CSRF_COOKIE_NAME,
  CSRF_MAX_AGE_SECONDS,
  createCsrfToken,
  isJsonMutation,
  isValidJsonMutationCsrf,
} from '$lib/server/auth/csrf';

if (!building) {
  initializeDatabase();
  startPolling();
}

/** Check if the user has completed onboarding */
function isSetupComplete(): boolean {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT value FROM app_settings WHERE key = 'setup_complete'")
      .get() as { value: string } | undefined;
    if (row?.value === 'true') return true;

    const feedRow = db.prepare('SELECT COUNT(*) as count FROM feeds').get() as
      { count: number } | undefined;
    return (feedRow?.count ?? 0) > 0;
  } catch {
    return false;
  }
}

function isOnboardingBypassPath(pathname: string): boolean {
  return (
    pathname === '/settings' ||
    pathname.startsWith('/settings/') ||
    pathname === '/api/settings' ||
    pathname.startsWith('/api/settings/') ||
    pathname === '/api/feeds' ||
    pathname.startsWith('/api/feeds/') ||
    pathname === '/api/opml' ||
    pathname.startsWith('/api/opml/') ||
    pathname === '/api/ai' ||
    pathname.startsWith('/api/ai/')
  );
}

function isPwaAssetPath(pathname: string): boolean {
  return (
    pathname === '/manifest.json' ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/registerSW.js' ||
    pathname === '/sw.js' ||
    /^\/workbox-[\w.-]+\.js$/.test(pathname)
  );
}

export const handle: Handle = async ({ event, resolve }) => {
  const csrfToken = event.cookies.get(CSRF_COOKIE_NAME) || createCsrfToken();
  if (!event.cookies.get(CSRF_COOKIE_NAME)) {
    event.cookies.set(CSRF_COOKIE_NAME, csrfToken, {
      path: '/',
      httpOnly: false,
      sameSite: 'strict',
      secure:
        event.url.protocol === 'https:' ||
        process.env.NODE_ENV === 'production',
      maxAge: CSRF_MAX_AGE_SECONDS,
    });
  }

  // Session validation
  const sessionId = event.cookies.get(getSessionCookieName());
  if (sessionId) {
    const session = validateSession(sessionId);
    if (session) {
      event.locals.sessionId = session.id;
    } else {
      event.cookies.delete(getSessionCookieName(), { path: '/' });
    }
  }

  // JSON mutations must originate from this app or carry the double-submit
  // token. Login is intentionally exempt because it creates the session.
  if (
    event.locals.sessionId &&
    isJsonMutation(event.request) &&
    event.url.pathname !== '/api/login'
  ) {
    if (!isValidJsonMutationCsrf(event.request, event.url.origin, csrfToken)) {
      return new Response(JSON.stringify({ error: 'CSRF validation failed' }), {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    }
  }

  // Auth guard for protected routes
  const publicPaths = new Set(['/login', '/api/login', '/api/logout']);
  const isPublicPath =
    publicPaths.has(event.url.pathname) || isPwaAssetPath(event.url.pathname);
  const isApiRoute = event.url.pathname.startsWith('/api/');

  if (!event.locals.sessionId && !isPublicPath) {
    if (isApiRoute) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw redirect(302, '/login');
  }

  // First-run detection: if logged in but setup not complete, redirect to onboarding
  if (event.locals.sessionId && !isPublicPath) {
    const setupComplete = isSetupComplete();
    if (
      !setupComplete &&
      event.url.pathname !== '/onboarding' &&
      !isOnboardingBypassPath(event.url.pathname)
    ) {
      throw redirect(302, '/onboarding');
    }
  }

  return resolve(event);
};

export const handleError: HandleServerError = ({
  error,
  event,
  status,
  message,
}) => {
  recordAppError({
    source: 'handleError',
    error,
    details: { status, fallbackMessage: message },
    path: event.url.pathname,
    method: event.request.method,
  });

  return {
    message,
  };
};
