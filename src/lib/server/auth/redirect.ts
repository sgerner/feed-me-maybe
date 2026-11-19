/** Accept only a same-origin path for post-login redirects. */
export function safeReturnTo(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  )
    return '/';

  try {
    const target = new URL(value, 'http://feed-me-maybe.local');
    if (
      target.origin !== 'http://feed-me-maybe.local' ||
      target.pathname.startsWith('//')
    )
      return '/';
    if (target.pathname === '/login' || target.pathname.startsWith('/api/')) {
      return '/';
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return '/';
  }
}
