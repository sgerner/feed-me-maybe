import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetDb,
  mockIsJevConfigured,
  mockIsRankingProviderConfigured,
  mockIsSubqConfigured,
  mockGetRankingProvider,
} = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockIsJevConfigured: vi.fn(),
  mockIsRankingProviderConfigured: vi.fn(),
  mockIsSubqConfigured: vi.fn(),
  mockGetRankingProvider: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ getDb: mockGetDb }));
vi.mock('$lib/server/ai/jev', () => ({
  isJevConfigured: mockIsJevConfigured,
  isRankingProviderConfigured: mockIsRankingProviderConfigured,
  isSubqConfigured: mockIsSubqConfigured,
}));
vi.mock('$lib/server/ranking-provider', () => ({
  getRankingProvider: mockGetRankingProvider,
}));

import { load } from './+page.server';

function eventWithSession(sessionId: string | null) {
  return { locals: { sessionId } } as Parameters<typeof load>[0];
}

function createStatusDb() {
  const db = {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes('FROM feeds')) return { c: 2 };
        if (sql.includes('FROM articles')) {
          return sql.includes('COUNT(jev_score)')
            ? { total: 3, scored: 1, missing: 2 }
            : { c: 3 };
        }
        if (sql.includes("status = 'queued'")) return { c: 2 };
        return undefined;
      }),
      all: vi.fn(() => {
        if (sql.includes('GROUP BY status')) {
          return [
            { status: 'queued', count: 2 },
            { status: 'failed', count: 1 },
          ];
        }
        if (sql.includes('ORDER BY created_at DESC, id DESC')) {
          return [
            {
              id: 'jev-retried',
              status: 'queued',
              attempts: 2,
              max_attempts: 4,
              scheduled_at: 5000,
              error_message: 'Temporary provider error',
            },
            {
              id: 'jev-failed',
              status: 'failed',
              attempts: 4,
              max_attempts: 4,
              scheduled_at: null,
              error_message: 'Retry budget exhausted',
            },
          ];
        }
        return [];
      }),
    })),
  };

  return db;
}

describe('settings status page load', () => {
  beforeEach(() => {
    mockGetDb.mockReset();
    mockIsJevConfigured.mockReset();
    mockIsRankingProviderConfigured.mockReset();
    mockIsSubqConfigured.mockReset();
    mockGetRankingProvider.mockReset();
  });

  it('does not load status data without an authenticated session', async () => {
    const result = await load(eventWithSession(null));

    expect(result).toEqual({});
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockIsJevConfigured).not.toHaveBeenCalled();
  });

  it('exposes Jev score totals and queued retry and failed job details', async () => {
    const db = createStatusDb();
    mockGetDb.mockReturnValue(db);
    mockIsJevConfigured.mockReturnValue(true);
    mockIsRankingProviderConfigured.mockReturnValue(true);
    mockIsSubqConfigured.mockReturnValue(false);
    mockGetRankingProvider.mockReturnValue('jev');

    const result = await load(eventWithSession('user-session'));

    expect(result).toMatchObject({
      feedCount: 2,
      articleCount: 3,
      jobCount: 2,
      jev: {
        configured: true,
        total: 3,
        scored: 1,
        missing: 2,
        jobs: [
          { status: 'queued', count: 2 },
          { status: 'failed', count: 1 },
        ],
        recentJobs: [
          {
            id: 'jev-retried',
            status: 'queued',
            attempts: 2,
            max_attempts: 4,
            scheduled_at: 5000,
            error_message: 'Temporary provider error',
          },
          {
            id: 'jev-failed',
            status: 'failed',
            attempts: 4,
            max_attempts: 4,
            scheduled_at: null,
            error_message: 'Retry budget exhausted',
          },
        ],
      },
      recentJobs: [],
      recentErrors: [],
    });
    expect(mockGetDb).toHaveBeenCalledOnce();
    expect(mockIsJevConfigured).toHaveBeenCalledOnce();
  });
});
