import { describe, expect, it } from 'vitest';
import {
  createCsrfToken,
  OFFLINE_PROTOCOL_HEADER,
  OFFLINE_PROTOCOL_VERSION,
  isValidJsonMutationCsrf,
} from './csrf';

describe('JSON mutation CSRF protection', () => {
  it('accepts a matching double-submit token', () => {
    const token = createCsrfToken();
    const request = new Request('http://localhost/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token },
    });

    expect(isValidJsonMutationCsrf(request, 'http://localhost', token)).toBe(
      true,
    );
  });

  it('accepts same-origin browser requests and rejects cross-origin requests', () => {
    const sameOrigin = new Request('http://localhost/api/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
    });
    const crossOrigin = new Request('http://localhost/api/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
    });

    expect(
      isValidJsonMutationCsrf(sameOrigin, 'http://localhost', undefined),
    ).toBe(true);
    expect(
      isValidJsonMutationCsrf(crossOrigin, 'http://localhost', undefined),
    ).toBe(false);
  });

  it('accepts the exact versioned offline replay protocol without exempting ordinary JSON', () => {
    const offlineReplay = new Request('http://localhost/api/interactions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OFFLINE_PROTOCOL_HEADER]: OFFLINE_PROTOCOL_VERSION,
      },
    });
    const wrongVersion = new Request('http://localhost/api/interactions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OFFLINE_PROTOCOL_HEADER]: 'v999',
      },
    });
    const ordinaryJson = new Request('http://localhost/api/interactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    expect(
      isValidJsonMutationCsrf(offlineReplay, 'http://localhost', undefined),
    ).toBe(true);
    expect(
      isValidJsonMutationCsrf(wrongVersion, 'http://localhost', undefined),
    ).toBe(false);
    expect(
      isValidJsonMutationCsrf(ordinaryJson, 'http://localhost', undefined),
    ).toBe(false);
  });
});
