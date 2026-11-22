import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent } from 'undici';
import { buildProxyRequestUrl } from '#lib/proxy.ts';

export const MAX_FEED_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_HTML_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 4;

const HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.test'];

export class SafeFetchError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_url'
      | 'private_network'
      | 'dns_failure'
      | 'too_many_redirects'
      | 'unsafe_redirect'
      | 'response_too_large'
      | 'unsupported_content_type',
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

const PRIVATE_IP_BLOCKLIST = new net.BlockList();
// IPv4 non-public / reserved / test-net ranges
PRIVATE_IP_BLOCKLIST.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE_IP_BLOCKLIST.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_IP_BLOCKLIST.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE_IP_BLOCKLIST.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_IP_BLOCKLIST.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE_IP_BLOCKLIST.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_IP_BLOCKLIST.addSubnet('192.0.0.0', 24, 'ipv4');
PRIVATE_IP_BLOCKLIST.addSubnet('192.0.2.0', 24, 'ipv4');
PRIVATE_IP_BLOCKLIST.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_IP_BLOCKLIST.addSubnet('198.18.0.0', 15, 'ipv4');
PRIVATE_IP_BLOCKLIST.addSubnet('198.51.100.0', 24, 'ipv4');
PRIVATE_IP_BLOCKLIST.addSubnet('203.0.113.0', 24, 'ipv4');
PRIVATE_IP_BLOCKLIST.addSubnet('224.0.0.0', 4, 'ipv4');
PRIVATE_IP_BLOCKLIST.addSubnet('240.0.0.0', 4, 'ipv4');
// IPv6 unspecified, loopback, IPv4-compatible, ULA, link-local, multicast, doc
PRIVATE_IP_BLOCKLIST.addSubnet('::', 96, 'ipv6');
PRIVATE_IP_BLOCKLIST.addSubnet('fc00::', 7, 'ipv6');
PRIVATE_IP_BLOCKLIST.addSubnet('fe80::', 10, 'ipv6');
PRIVATE_IP_BLOCKLIST.addSubnet('ff00::', 8, 'ipv6');
PRIVATE_IP_BLOCKLIST.addSubnet('2001:db8::', 32, 'ipv6');

export function isPrivateIpAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(normalized);
  if (family === 0) return true;
  return PRIVATE_IP_BLOCKLIST.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
}

export function validatePublicUrl(input: string | URL): URL {
  let parsed: URL;
  try {
    parsed = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new SafeFetchError('Invalid URL', 'invalid_url');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SafeFetchError(
      'Only http/https URLs are supported',
      'invalid_url',
    );
  }
  if (parsed.username || parsed.password) {
    throw new SafeFetchError(
      'URLs with embedded credentials are not supported',
      'invalid_url',
    );
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (
    !hostname ||
    hostname === 'localhost' ||
    (net.isIP(hostname) === 0 &&
      BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)))
  ) {
    throw new SafeFetchError(
      'Private network URLs are not allowed',
      'private_network',
    );
  }
  if (net.isIP(hostname) !== 0 && isPrivateIpAddress(hostname)) {
    throw new SafeFetchError(
      'Private network URLs are not allowed',
      'private_network',
    );
  }

  return parsed;
}

export async function assertPublicNetworkUrl(
  input: string | URL,
): Promise<URL> {
  return (await resolvePublicNetworkUrl(input)).url;
}

type ResolvedPublicNetworkUrl = {
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
};

async function resolvePublicNetworkUrl(
  input: string | URL,
): Promise<ResolvedPublicNetworkUrl> {
  const parsed = validatePublicUrl(input);
  const hostname = normalizeHostname(parsed.hostname);
  const ipFamily = net.isIP(hostname);
  if (ipFamily !== 0) {
    return {
      url: parsed,
      addresses: [{ address: hostname, family: ipFamily as 4 | 6 }],
    };
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(hostname, { all: true, order: 'verbatim' });
  } catch {
    throw new SafeFetchError('Unable to resolve remote host', 'dns_failure');
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateIpAddress(address))
  ) {
    throw new SafeFetchError(
      'Remote host resolves to a private network',
      'private_network',
    );
  }
  return {
    url: parsed,
    addresses: addresses.map(({ address }) => ({
      address,
      family: net.isIP(address) as 4 | 6,
    })),
  };
}

export function createPinnedLookup(
  resolved: string | Array<{ address: string; family: 4 | 6 }>,
  family?: 4 | 6,
) {
  const addresses =
    typeof resolved === 'string'
      ? [{ address: resolved, family: family ?? (net.isIP(resolved) as 4 | 6) }]
      : resolved;
  const first = addresses[0];
  if (!first) throw new Error('At least one resolved address is required');

  return (
    _hostname: string,
    options: number | { all?: boolean },
    callback: (...args: any[]) => void,
  ) => {
    if (typeof options === 'object' && options.all) {
      callback(null, addresses);
    } else {
      callback(null, first.address, first.family);
    }
  };
}

async function closeAgent(agent: Agent): Promise<void> {
  try {
    await agent.close();
  } catch {
    await agent.destroy();
  }
}

function responseWithAgentCleanup(response: Response, agent: Agent): Response {
  if (!response.body) {
    void closeAgent(agent);
    return response;
  }

  const reader = response.body.getReader();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await closeAgent(agent);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        await close();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await close();
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function fetchPinned(
  url: URL,
  init: RequestInit,
  addresses: ResolvedPublicNetworkUrl['addresses'],
): Promise<Response> {
  if (addresses.length === 0) {
    throw new SafeFetchError('Unable to resolve remote host', 'dns_failure');
  }

  const agent = new Agent({
    connect: { lookup: createPinnedLookup(addresses) },
    connections: 1,
    pipelining: 0,
  });
  try {
    const response = await fetch(url.href, {
      ...init,
      redirect: 'manual',
      dispatcher: agent,
    } as RequestInit);
    return responseWithAgentCleanup(response, agent);
  } catch (error) {
    await closeAgent(agent);
    throw error;
  }
}

function mimeType(response: Response): string {
  return (response.headers.get('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

export function hasAllowedContentType(
  response: Response,
  allowedContentTypes: readonly string[],
): boolean {
  const contentType = mimeType(response);
  return (
    !contentType ||
    allowedContentTypes.some((allowed) => contentType === allowed)
  );
}

export async function readResponseText(
  response: Response,
  maxBytes: number,
  decode = (bytes: Buffer) => bytes.toString('utf8'),
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SafeFetchError(
      'Remote response is too large',
      'response_too_large',
    );
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new SafeFetchError(
        'Remote response is too large',
        'response_too_large',
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('response_too_large');
        throw new SafeFetchError(
          'Remote response is too large',
          'response_too_large',
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return decode(Buffer.concat(chunks));
}

export type SafeFetchOptions = {
  proxyBaseUrl?: string;
  maxBytes?: number;
  maxRedirects?: number;
  allowedContentTypes?: readonly string[];
};

export async function fetchSafe(
  targetUrl: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<{ response: Response; finalUrl: string }> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let target = await resolvePublicNetworkUrl(targetUrl);
  const proxy = options.proxyBaseUrl
    ? validatePublicUrl(options.proxyBaseUrl).href
    : undefined;
  let requestInit = init;

  for (let redirectCount = 0; ; redirectCount += 1) {
    const request = proxy
      ? await resolvePublicNetworkUrl(
          buildProxyRequestUrl(proxy, target.url.href),
        )
      : target;
    const response = await fetchPinned(
      request.url,
      requestInit,
      request.addresses,
    );

    if (HTTP_REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      if (redirectCount >= maxRedirects) {
        throw new SafeFetchError('Too many redirects', 'too_many_redirects');
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new SafeFetchError(
          'Redirect did not include a location',
          'unsafe_redirect',
        );
      }
      const nextTarget = await resolvePublicNetworkUrl(
        new URL(location, target.url),
      );
      if (target.url.origin !== nextTarget.url.origin) {
        const headers = new Headers(requestInit.headers);
        headers.delete('authorization');
        headers.delete('cookie');
        headers.delete('proxy-authorization');
        requestInit = { ...requestInit, headers };
      }
      target = nextTarget;
      continue;
    }

    if (
      response.ok &&
      options.allowedContentTypes &&
      !hasAllowedContentType(response, options.allowedContentTypes)
    ) {
      await response.body?.cancel();
      throw new SafeFetchError(
        'Remote response has an unsupported content type',
        'unsupported_content_type',
      );
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (
      options.maxBytes &&
      Number.isFinite(declaredLength) &&
      declaredLength > options.maxBytes
    ) {
      await response.body?.cancel();
      throw new SafeFetchError(
        'Remote response is too large',
        'response_too_large',
      );
    }
    return { response, finalUrl: target.url.href };
  }
}
