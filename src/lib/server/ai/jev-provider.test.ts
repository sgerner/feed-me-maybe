import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

describe('selected ranking provider', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-ranking-provider.db');
  const testSubqKeyPath = `${testDbPath}.subq-key`;
  const originalDbUrl = process.env.DATABASE_URL;
  const originalEnv = {
    JEV_API_KEY: process.env.JEV_API_KEY,
    JEV_API_KEY_FILE: process.env.JEV_API_KEY_FILE,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    TYPESAFE_API_KEY_FILE: process.env.TYPESAFE_API_KEY_FILE,
    SUBQ_API_KEY: process.env.SUBQ_API_KEY,
    SUBQ_API_KEY_FILE: process.env.SUBQ_API_KEY_FILE,
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbPath;
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const { initializeDatabase } = await import('$lib/server/db/migrate');
    initializeDatabase();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    process.env.JEV_API_KEY = 'test-jev-key';
    process.env.TYPESAFE_API_KEY = '';
    process.env.JEV_API_KEY_FILE = '';
    process.env.TYPESAFE_API_KEY_FILE = '';
    process.env.SUBQ_API_KEY = 'test-subq-key';
    process.env.SUBQ_API_KEY_FILE = '';

    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    db.prepare('DELETE FROM ranking_refresh_queue').run();
    db.prepare('DELETE FROM jobs').run();
    db.prepare('DELETE FROM user_interactions').run();
    db.prepare('DELETE FROM user_preference_memory').run();
    db.prepare('DELETE FROM article_ai_metadata').run();
    db.prepare('DELETE FROM articles').run();
    db.prepare('DELETE FROM feeds').run();
    db.prepare(
      "DELETE FROM app_settings WHERE key IN ('ranking_provider_revision', 'ranking_feedback_revision')",
    ).run();
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('ranking_provider', 'jev', ?)
       ON CONFLICT(key) DO UPDATE SET value = 'jev', updated_at = excluded.updated_at`,
    ).run(Date.now());
    db.prepare(
      'INSERT INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'provider-feed',
      'https://example.com/provider.xml',
      'Provider feed',
      Date.now(),
      Date.now(),
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    const { closeDb } = await import('$lib/server/db');
    closeDb();
    process.env.DATABASE_URL = originalDbUrl ?? '';
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${testDbPath}${suffix}`))
        unlinkSync(`${testDbPath}${suffix}`);
    }
    if (existsSync(testSubqKeyPath)) unlinkSync(testSubqKeyPath);
  });

  async function insertArticle(id: string, jevScore: number | null = null) {
    const { getDb } = await import('$lib/server/db');
    const now = Date.now();
    getDb()
      .prepare(
        `INSERT INTO articles
           (id, feed_id, url, title, summary, content, jev_score,
            heuristic_score, combined_score, fetched_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 50, 77, ?, ?, ?)`,
      )
      .run(
        id,
        'provider-feed',
        `https://example.com/${id}`,
        'A reader relevant article',
        'A useful summary.',
        'A detailed article excerpt.',
        jevScore,
        now,
        now,
        now,
      );
  }

  it('defaults to Jev and reports provider availability without exposing keys', async () => {
    const { getDb } = await import('$lib/server/db');
    const { getRankingProviderSnapshot } =
      await import('$lib/server/ranking-provider');
    const { isJevConfigured, isRankingProviderConfigured, isSubqConfigured } =
      await import('./jev');
    getDb()
      .prepare("DELETE FROM app_settings WHERE key = 'ranking_provider'")
      .run();

    expect(getRankingProviderSnapshot()).toEqual({
      provider: 'jev',
      revision: 0,
    });
    expect(isJevConfigured()).toBe(true);
    expect(isSubqConfigured()).toBe(true);
    expect(isRankingProviderConfigured()).toBe(true);

    process.env.JEV_API_KEY = '';
    process.env.SUBQ_API_KEY = '';
    expect(isRankingProviderConfigured('jev')).toBe(false);
    expect(isRankingProviderConfigured('subq')).toBe(false);
  });

  it('checks a SubQ secret file without returning its contents', async () => {
    process.env.SUBQ_API_KEY = '';
    process.env.SUBQ_API_KEY_FILE = testSubqKeyPath;
    writeFileSync(testSubqKeyPath, 'file-subq-key\n', { mode: 0o600 });
    const { isSubqConfigured } = await import('./jev');

    expect(isSubqConfigured()).toBe(true);
  });

  it('allows a valid provider selection while reporting its missing key', async () => {
    process.env.SUBQ_API_KEY = '';
    process.env.SUBQ_API_KEY_FILE = '';
    const { applySettingsMutation } = await import('$lib/server/settings');

    expect(applySettingsMutation('ranking_provider', 'subq')).toMatchObject({
      success: true,
      provider: 'subq',
      configured: false,
      changed: true,
    });
  });

  it('sends the same would_open question to SubQ and stores its score', async () => {
    await insertArticle('subq-score');
    const { applySettingsMutation } = await import('$lib/server/settings');
    const { JEV_DECISION_QUESTIONS } = await import('./decision-input');
    const { scoreArticleWithJev } = await import('./jev');
    const { getDb } = await import('$lib/server/db');
    expect(applySettingsMutation('ranking_provider', 'subq')).toMatchObject({
      success: true,
      provider: 'subq',
      configured: true,
      changed: true,
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ answers: { would_open: { noul: 0.82 } } }),
        {
          status: 200,
        },
      ),
    );
    expect(await scoreArticleWithJev('subq-score')).toBe(0.82);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.subq.ai/v1/systemone');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer test-subq-key',
    });
    const payload = JSON.parse(String(init?.body));
    expect(payload.model).toBe('subq-snap-preview');
    expect(payload.questions.would_open).toEqual(
      JEV_DECISION_QUESTIONS.would_open,
    );
    expect(
      getDb()
        .prepare('SELECT jev_score FROM articles WHERE id = ?')
        .get('subq-score'),
    ).toEqual({ jev_score: 0.82 });
  });

  it.each(['jev', 'subq'] as const)(
    'rejects a null score from %s without overwriting the cached score',
    async (provider) => {
      if (provider === 'subq') {
        const { applySettingsMutation } = await import('$lib/server/settings');
        applySettingsMutation('ranking_provider', provider);
      }
      await insertArticle(`null-score-${provider}`, 0.45);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ answers: { would_open: { noul: null } } }),
          { status: 200 },
        ),
      );
      const { scoreArticleWithJev } = await import('./jev');
      const { getDb } = await import('$lib/server/db');

      await expect(
        scoreArticleWithJev(`null-score-${provider}`),
      ).rejects.toThrow('no usable would_open score');
      const row = getDb()
        .prepare('SELECT jev_score, jev_error FROM articles WHERE id = ?')
        .get(`null-score-${provider}`) as {
        jev_score: number;
        jev_error: string;
      };
      expect(row.jev_score).toBe(0.45);
      expect(row.jev_error).toContain('no usable would_open score');
    },
  );

  it('invalidates cached scores on switch and rejects in-flight results after switching back', async () => {
    await insertArticle('provider-race', 0.74);
    const { applySettingsMutation } = await import('$lib/server/settings');
    const { getDb } = await import('$lib/server/db');
    const { getRankingProviderSnapshot } =
      await import('$lib/server/ranking-provider');
    const { scoreArticleWithJev } = await import('./jev');
    let resolveFetch!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const pendingScore = scoreArticleWithJev('provider-race');
    expect(applySettingsMutation('ranking_provider', 'subq').changed).toBe(
      true,
    );
    expect(applySettingsMutation('ranking_provider', 'jev').changed).toBe(true);
    expect(getRankingProviderSnapshot()).toEqual({
      provider: 'jev',
      revision: 2,
    });
    expect(
      getDb()
        .prepare('SELECT jev_score FROM articles WHERE id = ?')
        .get('provider-race'),
    ).toEqual({ jev_score: null });

    resolveFetch(
      new Response(
        JSON.stringify({ answers: { would_open: { noul: 0.99 } } }),
        {
          status: 200,
        },
      ),
    );
    expect(await pendingScore).toBeNull();
    expect(
      getDb()
        .prepare('SELECT jev_score FROM articles WHERE id = ?')
        .get('provider-race'),
    ).toEqual({ jev_score: null });
    expect(
      getDb()
        .prepare(
          'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
        )
        .get('provider-race'),
    ).toEqual({ article_id: 'provider-race' });
  });

  it('rejects invalid provider values without changing the selection', async () => {
    const { applySettingsMutation } = await import('$lib/server/settings');
    expect(applySettingsMutation('ranking_provider', 'unknown')).toEqual({
      success: false,
      message: 'Invalid ranking provider',
    });
    const { getRankingProvider } = await import('$lib/server/ranking-provider');
    expect(getRankingProvider()).toBe('jev');
  });
});
