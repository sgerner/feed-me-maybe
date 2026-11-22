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

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]),
  },
}));

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
    const { initializeDatabase } = await import('#lib/server/db/migrate.ts');
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

    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    db.prepare('DELETE FROM ranking_refresh_queue').run();
    db.prepare('DELETE FROM jobs').run();
    db.prepare('DELETE FROM user_interactions').run();
    db.prepare('DELETE FROM user_preference_memory').run();
    db.prepare('DELETE FROM article_ai_metadata').run();
    db.prepare('DELETE FROM articles').run();
    db.prepare('DELETE FROM feeds').run();
    db.prepare(
      "DELETE FROM app_settings WHERE key IN ('ranking_provider_revision', 'ranking_feedback_revision', 'provider_cooldown_jev_process')",
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
    const { closeDb } = await import('#lib/server/db/index.ts');
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
    const { getDb } = await import('#lib/server/db/index.ts');
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
    const { getDb } = await import('#lib/server/db/index.ts');
    const { getRankingProviderSnapshot } =
      await import('#lib/server/ranking-provider.ts');
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
    const { applySettingsMutation } = await import('#lib/server/settings.ts');

    expect(applySettingsMutation('ranking_provider', 'subq')).toMatchObject({
      success: true,
      provider: 'subq',
      configured: false,
      changed: true,
    });
  });

  it('sends the same would_open question to SubQ and stores its score', async () => {
    await insertArticle('subq-score');
    const { applySettingsMutation } = await import('#lib/server/settings.ts');
    const { JEV_DECISION_QUESTIONS } = await import('./decision-input');
    const { scoreArticleWithJev } = await import('./jev');
    const { getDb } = await import('#lib/server/db/index.ts');
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

  it('deduplicates source preferences and ignores automatic hides', async () => {
    await insertArticle('profile-candidate');
    const { getDb } = await import('#lib/server/db/index.ts');
    const { scoreArticleWithJev } = await import('./jev');
    const db = getDb();
    const now = Date.now();
    const insertFeed = db.prepare(
      'INSERT INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    const insertSourceArticle = db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertInteraction = db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    );

    insertFeed.run(
      'automatic-hide-feed',
      'https://example.com/automatic-hide.xml',
      'Automatic Hide Feed',
      now,
      now,
    );
    insertFeed.run(
      'manual-hide-feed',
      'https://example.com/manual-hide.xml',
      'Manual Hide Feed',
      now,
      now,
    );
    insertSourceArticle.run(
      'profile-opened',
      'provider-feed',
      'https://example.com/profile-opened',
      'Opened article',
      now,
      now,
      now,
    );
    insertSourceArticle.run(
      'profile-auto-hidden',
      'automatic-hide-feed',
      'https://example.com/profile-auto-hidden',
      'Auto hidden article',
      now,
      now,
      now,
    );
    insertSourceArticle.run(
      'profile-manually-hidden',
      'manual-hide-feed',
      'https://example.com/profile-manually-hidden',
      'Manually hidden article',
      now,
      now,
      now,
    );
    insertInteraction.run(
      'profile-open-1',
      'profile-opened',
      'open',
      now,
      '{}',
    );
    insertInteraction.run(
      'profile-open-2',
      'profile-opened',
      'open',
      now + 1,
      '{}',
    );
    insertInteraction.run(
      'profile-read',
      'profile-opened',
      'read',
      now + 2,
      '{}',
    );
    insertInteraction.run(
      'profile-auto-hide',
      'profile-auto-hidden',
      'hide',
      now,
      '{"auto":true,"reason":"hide_on_open"}',
    );
    insertInteraction.run(
      'profile-manual-hide',
      'profile-manually-hidden',
      'hide',
      now,
      '{}',
    );

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ answers: { would_open: { noul: 0.82 } } }),
          { status: 200 },
        ),
      );
    await scoreArticleWithJev('profile-candidate');

    const payload = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    const profile = payload.state.reader_profile as {
      preferred_sources: Array<{ source: string; interactions: number }>;
      avoided_sources: Array<{ source: string; interactions: number }>;
    };
    expect(profile.preferred_sources).toContainEqual({
      source: 'Provider feed',
      interactions: 1,
    });
    expect(profile.avoided_sources).not.toContainEqual({
      source: 'Automatic Hide Feed',
      interactions: 1,
    });
    expect(profile.avoided_sources).toContainEqual({
      source: 'Manual Hide Feed',
      interactions: 1,
    });
  });

  it.each(['jev', 'subq'] as const)(
    'rejects a null score from %s without overwriting the cached score',
    async (provider) => {
      if (provider === 'subq') {
        const { applySettingsMutation } =
          await import('#lib/server/settings.ts');
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
      const { getDb } = await import('#lib/server/db/index.ts');

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

  it.each([-0.1, 1.1])(
    'rejects out-of-range ranking score %s without saving it',
    async (score) => {
      await insertArticle(`out-of-range-${score}`, 0.45);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ answers: { would_open: { noul: score } } }),
          { status: 200 },
        ),
      );
      const { scoreArticleWithJev } = await import('./jev');
      const { getDb } = await import('#lib/server/db/index.ts');

      await expect(
        scoreArticleWithJev(`out-of-range-${score}`),
      ).rejects.toThrow('no usable would_open score');
      expect(
        getDb()
          .prepare('SELECT jev_score FROM articles WHERE id = ?')
          .get(`out-of-range-${score}`),
      ).toEqual({ jev_score: 0.45 });
    },
  );

  it('invalidates cached scores on switch and rejects in-flight results after switching back', async () => {
    await insertArticle('provider-race', 0.74);
    const { applySettingsMutation } = await import('#lib/server/settings.ts');
    const { getDb } = await import('#lib/server/db/index.ts');
    const { getRankingProviderSnapshot } =
      await import('#lib/server/ranking-provider.ts');
    const { scoreArticleWithJev } = await import('./jev');
    getDb()
      .prepare(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('provider_cooldown_jev_process', ?, ?)",
      )
      .run(String(Date.now() + 60_000), Date.now());
    let resolveFetch!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const pendingScore = scoreArticleWithJev('provider-race');
    await vi.waitFor(() => expect(resolveFetch).toBeTypeOf('function'));
    expect(applySettingsMutation('ranking_provider', 'subq').changed).toBe(
      true,
    );
    expect(
      getDb()
        .prepare(
          "SELECT value FROM app_settings WHERE key = 'provider_cooldown_jev_process'",
        )
        .get(),
    ).toBeUndefined();
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
    const { applySettingsMutation } = await import('#lib/server/settings.ts');
    expect(applySettingsMutation('ranking_provider', 'unknown')).toEqual({
      success: false,
      message: 'Invalid ranking provider',
    });
    const { getRankingProvider } =
      await import('#lib/server/ranking-provider.ts');
    expect(getRankingProvider()).toBe('jev');
  });

  it('aligns decayed preference weights, polarity evidence counts, source signals, and blank feed title fallback', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { scoreArticleWithJev } = await import('./jev');
    const db = getDb();
    const now = Date.now();

    db.prepare('DELETE FROM user_preference_memory').run();
    db.prepare('DELETE FROM user_interactions').run();
    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-blank-title', 'https://blank.example.com/rss', '   ', now, now);
    db.prepare(
      'INSERT OR REPLACE INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('feed-good', 'https://good.example.com/rss', 'Good Source', now, now);
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, summary, content, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 50, ?, ?, ?)',
    ).run(
      'profile-candidate',
      'feed-blank-title',
      'https://blank.example.com/cand',
      'Candidate Story',
      'Summary',
      'Content',
      now,
      now,
      now,
    );
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, summary, content, thumbs_up, thumbs_down, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 50, ?, ?, ?)',
    ).run(
      'mixed-down-article',
      'feed-blank-title',
      'https://blank.example.com/down',
      'Downvoted Open',
      'Summary',
      'Content',
      now,
      now,
      now,
    );
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, summary, content, thumbs_up, thumbs_down, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 50, ?, ?, ?)',
    ).run(
      'liked-saved-article',
      'feed-good',
      'https://good.example.com/saved',
      'Saved Liked Story',
      'Summary',
      'Content',
      now,
      now,
      now,
    );
    db.prepare(
      'INSERT OR REPLACE INTO articles (id, feed_id, url, title, summary, content, thumbs_up, thumbs_down, heuristic_score, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 50, ?, ?, ?)',
    ).run(
      'hidden-then-up-article',
      'feed-good',
      'https://good.example.com/up',
      'Hidden Then Liked Story',
      'Summary',
      'Content',
      now,
      now,
      now,
    );

    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run('i-open-down', 'mixed-down-article', 'open', now - 1000, '{}');
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run('i-down', 'mixed-down-article', 'thumbs_down', now, '{}');
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run('i-save-liked', 'liked-saved-article', 'save', now, '{}');
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run('i-hide-up', 'hidden-then-up-article', 'hide', now - 1000, '{}');
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run('i-up-override', 'hidden-then-up-article', 'thumbs_up', now, '{}');

    db.prepare(
      'INSERT INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('m-pos', 'topic:systems', 'topic', 'positive', 0.8, 5, now, '', now);
    db.prepare(
      'INSERT INTO user_preference_memory (id, label, type, polarity, strength, evidence_count, last_reinforced, explanation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('m-neg', 'topic:systems', 'topic', 'negative', 0.3, 20, now, '', now);

    let sentState: Record<string, unknown> | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        state: Record<string, unknown>;
      };
      sentState = body.state;
      return new Response(
        JSON.stringify({ answers: { would_open: { noul: 0.7 } } }),
        { status: 200 },
      );
    });

    await scoreArticleWithJev('profile-candidate');
    const state = sentState as unknown as {
      candidate: { source: string };
      reader_profile: {
        positive_preferences: Array<{
          type: string;
          value: string;
          strength: number;
          evidence_count: number;
        }>;
        preferred_sources: Array<{ source: string; interactions: number }>;
        avoided_sources: Array<{ source: string; interactions: number }>;
      };
    };
    expect(state.candidate.source).toBe('https://blank.example.com/rss');
    const sysPref = state.reader_profile.positive_preferences.find(
      (p) => p.value === 'systems',
    );
    expect(sysPref).toBeDefined();
    expect(sysPref!.evidence_count).toBe(5);
    expect(sysPref!.strength).toBeCloseTo(0.5, 2);
    expect(state.reader_profile.preferred_sources).toEqual([
      { source: 'Good Source', interactions: 1 },
    ]);
    expect(state.reader_profile.avoided_sources).toEqual([
      { source: 'https://blank.example.com/rss', interactions: 1 },
    ]);
  });

  it('rejects in-flight scores after stub content upgrades while allowing read/save updated_at bumps', async () => {
    await insertArticle('stub-upgrade-race');
    await insertArticle('read-bump-ok');
    const { getDb } = await import('#lib/server/db/index.ts');
    const { scoreArticleWithJev } = await import('./jev');
    const db = getDb();

    let resolveUpgradeFetch!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveUpgradeFetch = resolve;
        }),
    );

    const upgradePromise = scoreArticleWithJev('stub-upgrade-race');
    await vi.waitFor(() => expect(resolveUpgradeFetch).toBeTypeOf('function'));
    db.prepare(
      'UPDATE articles SET content = ?, updated_at = ? WHERE id = ?',
    ).run(
      'Much longer full article body arrived mid-flight.',
      Date.now(),
      'stub-upgrade-race',
    );
    resolveUpgradeFetch(
      new Response(
        JSON.stringify({ answers: { would_open: { noul: 0.12 } } }),
        { status: 200 },
      ),
    );
    expect(await upgradePromise).toBeNull();
    expect(
      db
        .prepare('SELECT jev_score FROM articles WHERE id = ?')
        .pluck()
        .get('stub-upgrade-race'),
    ).toBeNull();
    expect(
      db
        .prepare(
          'SELECT article_id FROM ranking_refresh_queue WHERE article_id = ?',
        )
        .get('stub-upgrade-race'),
    ).toEqual({ article_id: 'stub-upgrade-race' });

    let resolveReadFetch!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveReadFetch = resolve;
        }),
    );
    const readPromise = scoreArticleWithJev('read-bump-ok');
    await vi.waitFor(() => expect(resolveReadFetch).toBeTypeOf('function'));
    db.prepare(
      'UPDATE articles SET read = 1, saved = 1, updated_at = ? WHERE id = ?',
    ).run(Date.now() + 5000, 'read-bump-ok');
    resolveReadFetch(
      new Response(
        JSON.stringify({ answers: { would_open: { noul: 0.88 } } }),
        { status: 200 },
      ),
    );
    expect(await readPromise).toBe(0.88);
    expect(
      db
        .prepare('SELECT jev_score FROM articles WHERE id = ?')
        .pluck()
        .get('read-bump-ok'),
    ).toBe(0.88);
  });

  it('reuses cached reader profile across articles when feedback revision and interaction stats are unchanged', async () => {
    await insertArticle('cache-art-1');
    await insertArticle('cache-art-2');
    const { getDb } = await import('#lib/server/db/index.ts');
    const { clearReaderProfileCache, scoreArticleWithJev } =
      await import('./jev');
    const db = getDb();

    clearReaderProfileCache();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ answers: { would_open: { noul: 0.75 } } }),
          { status: 200 },
        ),
    );
    const prepareSpy = vi.spyOn(db, 'prepare');

    expect(await scoreArticleWithJev('cache-art-1')).toBe(0.75);
    const interactionScansAfterFirst = prepareSpy.mock.calls.filter(([sql]) =>
      String(sql).includes('COUNT(DISTINCT a.id) AS interaction_count'),
    ).length;
    expect(interactionScansAfterFirst).toBe(2);

    expect(await scoreArticleWithJev('cache-art-2')).toBe(0.75);
    const interactionScansAfterSecond = prepareSpy.mock.calls.filter(([sql]) =>
      String(sql).includes('COUNT(DISTINCT a.id) AS interaction_count'),
    ).length;
    // Cached profile must not re-run the two user_interactions GROUP BY scans
    expect(interactionScansAfterSecond).toBe(2);
  });
});
