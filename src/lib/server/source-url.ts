export function normalizeSourceUrl(
  value: string,
  stripTracking = false,
  preserveFragment = false,
): string {
  if (!value) return '';
  try {
    const url = new URL(value.trim());
    if (!preserveFragment) url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (url.protocol === 'http:' && url.port === '80') url.port = '';
    if (url.protocol === 'https:' && url.port === '443') url.port = '';

    if (stripTracking) {
      for (const key of [...url.searchParams.keys()]) {
        if (
          /^utm_/i.test(key) ||
          ['fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid'].includes(
            key.toLowerCase(),
          )
        ) {
          url.searchParams.delete(key);
        }
      }
    }

    const sortedParams = [...url.searchParams.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    url.search = '';
    for (const [key, val] of sortedParams) url.searchParams.append(key, val);

    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.href;
  } catch {
    return value.trim();
  }
}

export function normalizeFeedSourceUrl(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return value.trim();
    }
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (url.protocol === 'http:' && url.port === '80') url.port = '';
    if (url.protocol === 'https:' && url.port === '443') url.port = '';
    return url.href;
  } catch {
    return value.trim();
  }
}
