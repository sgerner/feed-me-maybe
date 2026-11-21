import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { isSafeTargetUrl } from './index.js';

describe('proxy target URL validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts public IPv4-mapped targets in compressed and expanded forms', () => {
    expect(isSafeTargetUrl('https://[::ffff:8.8.8.8]/')).toBe(true);
    expect(isSafeTargetUrl('https://[::ffff:808:808]/')).toBe(true);
    expect(isSafeTargetUrl('https://[0:0:0:0:0:ffff:808:808]/')).toBe(true);
  });

  it('blocks TEST-NET-2 198.51.100.0/24 while allowing public 198.51 addresses', () => {
    expect(isSafeTargetUrl('https://198.51.100.1/')).toBe(false);
    expect(isSafeTargetUrl('https://198.51.101.1/')).toBe(true);
  });

  it('rejects malformed target URLs without reaching fetch', () => {
    expect(isSafeTargetUrl('https://[not-an-ipv6-literal]/')).toBe(false);
  });

  it('rejects disallowed content types even on non-2xx responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<svg onload="alert(1)"/>', {
          status: 404,
          headers: { 'content-type': 'image/svg+xml' },
        }),
      ),
    );

    const res = await worker.fetch(
      new Request('https://proxy.example/?url=https://8.8.8.8/r/test.json'),
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('Unsupported content type');
  });

  it('drops unsafe upstream headers and attaches security headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{"ok":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            etag: '"abc"',
            'set-cookie': 'session=secret; HttpOnly',
            'x-custom-secret': 'leak',
            'content-security-policy': 'default-src *',
          },
        }),
      ),
    );

    const res = await worker.fetch(
      new Request('https://proxy.example/?url=https://8.8.8.8/r/test.json'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-custom-secret')).toBeNull();
    expect(res.headers.get('etag')).toBe('"abc"');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe(
      "sandbox; default-src 'none'",
    );
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cross-origin-resource-policy')).toBe(
      'cross-origin',
    );
  });
});
