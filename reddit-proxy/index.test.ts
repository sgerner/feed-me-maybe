import { describe, expect, it } from 'vitest';
import { isSafeTargetUrl } from './index.js';

describe('proxy target URL validation', () => {
  it('accepts public IPv4-mapped targets in compressed and expanded forms', () => {
    expect(isSafeTargetUrl('https://[::ffff:8.8.8.8]/')).toBe(true);
    expect(isSafeTargetUrl('https://[::ffff:808:808]/')).toBe(true);
    expect(isSafeTargetUrl('https://[0:0:0:0:0:ffff:808:808]/')).toBe(true);
  });

  it('rejects malformed target URLs without reaching fetch', () => {
    expect(isSafeTargetUrl('https://[not-an-ipv6-literal]/')).toBe(false);
  });
});
