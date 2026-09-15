import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchArchivedArticle } from './archive';

describe('archive fetching safety', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not send private article URLs to archive services', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchArchivedArticle(
      'http://169.254.169.254/latest/meta-data',
      'metadata',
    );

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
