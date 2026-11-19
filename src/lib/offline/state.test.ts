import { describe, expect, it } from 'vitest';
import { matchesOfflineVisibility } from './state';

describe('offline article visibility', () => {
  it('hides rejected and hidden articles from ordinary views', () => {
    expect(
      matchesOfflineVisibility({ hidden: false, thumbs_down: false }),
    ).toBe(true);
    expect(matchesOfflineVisibility({ hidden: true, thumbs_down: false })).toBe(
      false,
    );
    expect(matchesOfflineVisibility({ hidden: false, thumbs_down: true })).toBe(
      false,
    );
  });

  it('keeps explicit hidden and rejected views available', () => {
    expect(
      matchesOfflineVisibility({ hidden: true, thumbs_down: false }, 'hidden'),
    ).toBe(true);
    expect(
      matchesOfflineVisibility({ hidden: true, thumbs_down: true }, 'rejected'),
    ).toBe(true);
  });
});
