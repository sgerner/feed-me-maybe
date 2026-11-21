import { afterEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import {
  createPinnedLookup,
  fetchSafe,
  isPrivateIpAddress,
  readResponseText,
  validatePublicUrl,
} from './network';

describe('safe server-side networking', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recognizes private, loopback, link-local, and mapped addresses', () => {
    expect(isPrivateIpAddress('10.0.0.4')).toBe(true);
    expect(isPrivateIpAddress('127.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('169.254.169.254')).toBe(true);
    expect(isPrivateIpAddress('::1')).toBe(true);
    expect(isPrivateIpAddress('fc00::1')).toBe(true);
    expect(isPrivateIpAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('198.51.100.1')).toBe(true);
    expect(isPrivateIpAddress('198.51.101.1')).toBe(false);
    expect(isPrivateIpAddress('1.1.1.1')).toBe(false);
  });

  it('rejects private destinations and embedded credentials', () => {
    expect(() => validatePublicUrl('http://localhost:3000/feed')).toThrow(
      /private network/i,
    );
    expect(() => validatePublicUrl('http://127.0.0.1/feed')).toThrow(
      /private network/i,
    );
    expect(() =>
      validatePublicUrl('https://user:pass@example.com/feed'),
    ).toThrow(/credentials/i);
  });

  it('blocks redirects into private networks before making the next request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/private' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSafe('https://1.1.1.1/feed')).rejects.toMatchObject({
      code: 'private_network',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pins the validated DNS addresses into the request dispatcher', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(
      async () =>
        [
          { address: '8.8.8.8', family: 4 },
          { address: '8.8.4.4', family: 4 },
        ] as never,
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    const { response } = await fetchSafe('https://rebind.example/feed');

    expect(lookup).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    expect(fetchMock.mock.calls[0][1]).toHaveProperty('dispatcher');

    const pinnedLookup = createPinnedLookup([
      { address: '8.8.8.8', family: 4 },
      { address: '8.8.4.4', family: 4 },
    ]);
    const callback = vi.fn();
    pinnedLookup('rebind.example', { all: false }, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    pinnedLookup('rebind.example', { all: true }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, [
      { address: '8.8.8.8', family: 4 },
      { address: '8.8.4.4', family: 4 },
    ]);

    await response.body?.cancel();
  });

  it('limits streamed response bodies', async () => {
    await expect(
      readResponseText(new Response('12345'), 4),
    ).rejects.toMatchObject({
      code: 'response_too_large',
    });
  });
});
