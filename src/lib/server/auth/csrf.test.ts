import { describe, expect, it } from 'vitest';
import {
  createCsrfToken,
  isCsrfProtectedMutation,
  OFFLINE_PROTOCOL_HEADER,
  OFFLINE_PROTOCOL_VERSION,
  isValidMutationCsrf,
} from './csrf';

describe('mutation CSRF protection', () => {
  it('accepts a matching double-submit token', () => {
    const token = createCsrfToken();
    const request = new Request('http://localhost/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token },
    });

    expect(isValidMutationCsrf(request, 'http://localhost', token)).toBe(true);
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

    expect(isValidMutationCsrf(sameOrigin, 'http://localhost', undefined)).toBe(
      true,
    );
    expect(
      isValidMutationCsrf(crossOrigin, 'http://localhost', undefined),
    ).toBe(false);
  });

  it('protects bodyless mutations and mutations without a JSON content type', () => {
    const bodylessCrossOrigin = new Request('http://localhost/api/feeds/1', {
      method: 'DELETE',
      headers: { origin: 'https://evil.example' },
    });
    const sameOriginBodyless = new Request('http://localhost/api/feeds/1', {
      method: 'DELETE',
      headers: { origin: 'http://localhost' },
    });
    const tokenProtected = new Request('http://localhost/api/feeds/1', {
      method: 'POST',
      headers: { 'x-csrf-token': 'valid-token' },
    });

    expect(
      isValidMutationCsrf(bodylessCrossOrigin, 'http://localhost', 'token'),
    ).toBe(false);
    expect(
      isValidMutationCsrf(sameOriginBodyless, 'http://localhost', 'token'),
    ).toBe(true);
    expect(
      isValidMutationCsrf(tokenProtected, 'http://localhost', 'valid-token'),
    ).toBe(true);
    expect(isCsrfProtectedMutation(bodylessCrossOrigin)).toBe(true);
    expect(
      isCsrfProtectedMutation(new Request('http://localhost/api/feeds/1')),
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
      isValidMutationCsrf(offlineReplay, 'http://localhost', undefined),
    ).toBe(true);
    expect(
      isValidMutationCsrf(wrongVersion, 'http://localhost', undefined),
    ).toBe(false);
    expect(
      isValidMutationCsrf(ordinaryJson, 'http://localhost', undefined),
    ).toBe(false);
  });
});
