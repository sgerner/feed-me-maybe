const CSRF_COOKIE_NAME = 'feed-me-maybe-csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';

/**
 * Add the double-submit token to browser mutations. The server also accepts
 * same-origin Fetch Metadata, but the explicit token keeps native browsers
 * and installed PWAs consistent when Origin is omitted.
 */
export function getCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;

  const prefix = `${CSRF_COOKIE_NAME}=`;
  const cookie = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));

  if (!cookie) return null;

  try {
    return decodeURIComponent(cookie.slice(prefix.length));
  } catch {
    return null;
  }
}

export function csrfHeaders(headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  const token = getCsrfToken();
  if (token) next.set(CSRF_HEADER_NAME, token);
  return next;
}

export function fetchWithCsrf(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: csrfHeaders(init.headers),
  });
}
