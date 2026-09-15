import crypto from 'node:crypto';

export const CSRF_COOKIE_NAME = 'feed-me-maybe-csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const CSRF_MAX_AGE_SECONDS = 24 * 60 * 60;
export const OFFLINE_PROTOCOL_HEADER = 'x-offline-protocol';
export const OFFLINE_PROTOCOL_VERSION = 'v1';

export function createCsrfToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isSameOrigin(value: string | null, expectedOrigin: string): boolean {
  if (!value) return false;
  try {
    return new URL(value).origin === expectedOrigin;
  } catch {
    return false;
  }
}

/**
 * Validate cookie-authenticated JSON mutations using Fetch Metadata's Origin
 * boundary, with a double-submit token fallback for native clients that do
 * not send Origin or Referer.
 *
 * Service-worker replay cannot read the non-HttpOnly CSRF cookie. It is
 * therefore allowed through a versioned custom protocol header. Browsers do
 * not attach custom headers to cross-site HTML form submissions, and a
 * cross-origin script would still need the server to opt into CORS. This
 * exception is deliberately exact and does not weaken ordinary JSON requests.
 */
export function isValidJsonMutationCsrf(
  request: Request,
  expectedOrigin: string,
  csrfCookie: string | undefined,
): boolean {
  if (
    request.headers.get(OFFLINE_PROTOCOL_HEADER) === OFFLINE_PROTOCOL_VERSION
  ) {
    return true;
  }

  const headerToken = request.headers.get(CSRF_HEADER_NAME);
  if (headerToken && csrfCookie && timingSafeEqual(headerToken, csrfCookie)) {
    return true;
  }

  const origin = request.headers.get('origin');
  if (origin) return isSameOrigin(origin, expectedOrigin);

  return isSameOrigin(request.headers.get('referer'), expectedOrigin);
}

export function isJsonMutation(request: Request): boolean {
  return (
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
    (request.headers.get('content-type') || '')
      .toLowerCase()
      .includes('application/json')
  );
}
