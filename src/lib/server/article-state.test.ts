import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createTestDb, type TestDbHandle } from '#lib/server/db/test-db.ts';

vi.mock('#lib/server/webhooks.ts', () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

describe('article state foundation', () => {
  let testDb: TestDbHandle;

  beforeAll(() => {
    testDb = createTestDb('feed-me-maybe-article-state-');
  });

  beforeEach(() => {
    testDb.reset();
    const db = testDb.db;
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'feed-state',
      'https://example.com/state.xml',
      'State Feed',
      now,
      now,
    );
    const insertArticle = db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insertArticle.run(
      'state-a',
      'feed-state',
      'https://example.com/a',
      'State A',
      now,
      now,
      now,
    );
    insertArticle.run(
      'state-b',
      'feed-state',
      'https://example.com/b',
      'State B',
      now,
      now,
      now,
    );
  });

  afterAll(() => {
    testDb.cleanup();
  });

  it('applies explicit timestamps and replays idempotently', async () => {
    const { applyArticleState, getArticleState, getArticleStateHistory } =
      await import('./article-state');
    const first = applyArticleState({
      articleIds: ['state-a'],
      action: 'read',
      idempotencyKey: 'read-state-a-v1',
    });
    const replay = applyArticleState({
      articleIds: ['state-a'],
      action: 'read',
      idempotencyKey: 'read-state-a-v1',
    });
    const state = getArticleState('state-a');

    expect(first.idempotent).toBe(false);
    expect(replay.idempotent).toBe(true);
    expect(replay.operationId).toBe(first.operationId);
    expect(state?.read).toBe(true);
    expect(state?.readAt).toBeTypeOf('number');
    expect(getArticleStateHistory({ articleId: 'state-a' })).toHaveLength(1);
  });

  it('supports atomic bulk transitions and exact recovery', async () => {
    const { applyArticleState, getArticleState, undoArticleState } =
      await import('./article-state');
    const mutation = applyArticleState({
      articleIds: ['state-a', 'state-b'],
      action: 'hide',
      idempotencyKey: 'hide-batch-v1',
    });
    expect(mutation.changes).toHaveLength(2);
    expect(getArticleState('state-a')?.hidden).toBe(true);
    expect(getArticleState('state-b')?.hidden).toBe(true);

    const undone = undoArticleState({ operationId: mutation.operationId });
    expect(undone.restoredArticleIds.sort()).toEqual(['state-a', 'state-b']);
    expect(undone.conflicts).toEqual([]);
    expect(getArticleState('state-a')?.hidden).toBe(false);
    expect(getArticleState('state-b')?.hidden).toBe(false);
  });

  it('records explicit hide intent on an auto-hidden article and reverses it safely', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { applyArticleState, getArticleState, undoArticleState } =
      await import('./article-state');
    const { hasExplicitHide, calculateHeuristicScore } =
      await import('./preferences');
    const db = getDb();
    db.prepare(
      "UPDATE articles SET hidden = 1, hidden_at = 100 WHERE id = 'state-a'",
    ).run();
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'automatic-hide',
      'state-a',
      'hide',
      100,
      '{"auto":true,"reason":"preference_model"}',
    );

    const scoreBeforeHide = calculateHeuristicScore('state-a');
    const firstHide = applyArticleState({
      articleIds: ['state-a'],
      action: 'hide',
      idempotencyKey: 'explicit-hide-after-auto-v1',
    });
    expect(firstHide.changes[0].changed).toBe(true);
    expect(getArticleState('state-a')?.hidden).toBe(true);
    expect(hasExplicitHide('state-a')).toBe(true);
    expect(
      (
        db
          .prepare("SELECT heuristic_score FROM articles WHERE id = 'state-a'")
          .get() as { heuristic_score: number }
      ).heuristic_score,
    ).toBeLessThanOrEqual(scoreBeforeHide - 10);

    const undone = undoArticleState({ operationId: firstHide.operationId });
    expect(undone.restoredArticleIds).toEqual(['state-a']);
    expect(getArticleState('state-a')?.hidden).toBe(true);
    expect(hasExplicitHide('state-a')).toBe(false);

    const hiddenAgain = applyArticleState({
      articleIds: ['state-a'],
      action: 'hide',
      idempotencyKey: 'explicit-hide-after-restore-v1',
    });
    expect(hiddenAgain.changes[0].changed).toBe(true);
    expect(hasExplicitHide('state-a')).toBe(true);
  });

  it('undoes a hide when a compatibility trigger fills an existing saved timestamp', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { applyArticleState, getArticleState, undoArticleState } =
      await import('./article-state');
    const db = getDb();
    db.prepare("UPDATE articles SET saved = 1 WHERE id = 'state-a'").run();
    db.prepare(
      "UPDATE articles SET saved_at = NULL WHERE id = 'state-a'",
    ).run();
    const change = applyArticleState({
      articleIds: ['state-a'],
      action: 'hide',
    });

    expect(change.changes[0].after).toEqual(getArticleState('state-a'));
    expect(
      undoArticleState({ operationId: change.operationId }).restoredArticleIds,
    ).toEqual(['state-a']);
    expect(getArticleState('state-a')).toMatchObject({
      saved: true,
      hidden: false,
    });
  });

  it('does not overwrite a later state change during undo', async () => {
    const { applyArticleState, getArticleState, undoArticleState } =
      await import('./article-state');
    const first = applyArticleState({
      articleIds: ['state-a'],
      action: 'read',
      idempotencyKey: 'read-conflict-v1',
    });
    applyArticleState({
      articleIds: ['state-a'],
      action: 'unread',
      idempotencyKey: 'unread-conflict-v1',
    });

    const undone = undoArticleState({ operationId: first.operationId });
    expect(undone.restoredArticleIds).toEqual([]);
    expect(undone.conflicts).toEqual(['state-a']);
    expect(getArticleState('state-a')?.read).toBe(false);
  });

  it('retracts rejection preference deltas and tags the exact interaction on undo', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { applyArticleState, undoArticleState, getArticleState } =
      await import('./article-state');
    const db = getDb();
    const mutation = applyArticleState({
      articleIds: ['state-a'],
      action: 'reject',
      idempotencyKey: 'reject-undo-v1',
    });
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM user_preference_memory')
          .get() as { count: number }
      ).count,
    ).toBeGreaterThan(0);

    const undone = undoArticleState({ operationId: mutation.operationId });
    const feedback = db
      .prepare(
        `SELECT interaction_type, metadata FROM user_interactions
         WHERE article_id = 'state-a' AND interaction_type = 'thumbs_down'`,
      )
      .get() as { interaction_type: string; metadata: string };
    const metadata = JSON.parse(feedback.metadata) as Record<string, unknown>;

    expect(undone.restoredArticleIds).toEqual(['state-a']);
    expect(getArticleState('state-a')).toMatchObject({
      thumbsDown: false,
      rejected: false,
      hidden: false,
    });
    expect(metadata).toMatchObject({
      operation_id: mutation.operationId,
    });
    expect(metadata.undone_at).toEqual(expect.any(Number));
    expect(typeof metadata.undo_operation_id).toBe('string');
    expect(metadata.undo_operation_id).not.toBe(mutation.operationId);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM user_preference_memory').get(),
    ).toEqual({ count: 0 });
  });

  it('retracts an active rejection when an article is explicitly restored', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { applyArticleState, getArticleState } =
      await import('./article-state');
    const db = getDb();
    const rejection = applyArticleState({
      articleIds: ['state-a'],
      action: 'reject',
      idempotencyKey: 'reject-restore-v1',
    });

    const restore = applyArticleState({
      articleIds: ['state-a'],
      action: 'restore',
      idempotencyKey: 'restore-reject-v1',
    });
    const feedback = db
      .prepare(
        `SELECT metadata FROM user_interactions
         WHERE article_id = 'state-a' AND interaction_type = 'thumbs_down'`,
      )
      .get() as { metadata: string };
    const restoredEvent = db
      .prepare(
        `SELECT metadata FROM user_interactions
         WHERE article_id = 'state-a' AND interaction_type = 'restore'`,
      )
      .get() as { metadata: string };
    const feedbackMetadata = JSON.parse(feedback.metadata) as Record<
      string,
      unknown
    >;
    const restoredMetadata = JSON.parse(restoredEvent.metadata) as Record<
      string,
      unknown
    >;

    expect(restore.operationId).not.toBe(rejection.operationId);
    expect(getArticleState('state-a')).toMatchObject({
      thumbsDown: false,
      rejected: false,
      hidden: false,
    });
    expect(feedbackMetadata.undone_at).toEqual(expect.any(Number));
    expect(restoredMetadata.undo_of_operation_ids).toEqual([
      rejection.operationId,
    ]);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM user_preference_memory').get(),
    ).toEqual({ count: 0 });
  });

  it('reports unread counts by feed and state', async () => {
    const { applyArticleState, getUnreadCounts } =
      await import('./article-state');
    applyArticleState({
      articleIds: ['state-a'],
      action: 'read',
      idempotencyKey: 'counts-read-v1',
    });
    applyArticleState({
      articleIds: ['state-b'],
      action: 'reject',
      idempotencyKey: 'counts-reject-v1',
    });
    const counts = getUnreadCounts();

    expect(counts.totalUnread).toBe(1);
    expect(counts.rejectedUnread).toBe(1);
    expect(counts.feeds).toEqual([
      expect.objectContaining({
        feedId: 'feed-state',
        unread: 1,
        visibleUnread: 0,
      }),
    ]);
  });

  it('excludes paused feeds from unread counts', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { getUnreadCounts } = await import('./article-state');
    const db = getDb();
    const beforeUnread = getUnreadCounts();
    const now = Date.now();
    db.prepare(
      'INSERT INTO feeds (id, url, title, enabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    ).run('feed-paused', 'https://paused.example.com/rss', 'Paused', now, now);
    db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, read, saved, hidden, rejected, thumbs_down, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 1, 0, 0, 0, ?, ?, ?)',
    ).run(
      'paused-unread-1',
      'feed-paused',
      'https://paused.example.com/1',
      'Paused Unread',
      now,
      now,
      now,
    );

    const unread = getUnreadCounts();
    expect(unread.feeds.map((f) => f.feedId)).not.toContain('feed-paused');
    expect(unread.totalUnread).toBe(beforeUnread.totalUnread);
  });

  it('reverses save and read preference memory on unsave and unread without inflating scores', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { applyArticleState, getArticleState } =
      await import('./article-state');
    const db = getDb();
    db.prepare('UPDATE articles SET author = ? WHERE id = ?').run(
      'Save Author',
      'state-a',
    );

    applyArticleState({ articleIds: ['state-a'], action: 'save' });
    const afterFirstSave = db
      .prepare(
        "SELECT strength, evidence_count FROM user_preference_memory WHERE label = 'author:save_author'",
      )
      .get() as { strength: number; evidence_count: number };
    expect(afterFirstSave.evidence_count).toBe(1);

    applyArticleState({ articleIds: ['state-a'], action: 'unsave' });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM user_preference_memory WHERE label = 'author:save_author'",
        )
        .get(),
    ).toEqual({ c: 0 });
    expect(getArticleState('state-a')?.saved).toBe(false);

    applyArticleState({ articleIds: ['state-a'], action: 'save' });
    const afterSecondSave = db
      .prepare(
        "SELECT strength, evidence_count FROM user_preference_memory WHERE label = 'author:save_author'",
      )
      .get() as { strength: number; evidence_count: number };
    expect(afterSecondSave.evidence_count).toBe(1);
    expect(afterSecondSave.strength).toBeCloseTo(afterFirstSave.strength, 5);

    applyArticleState({ articleIds: ['state-a'], action: 'read' });
    expect(
      db
        .prepare(
          "SELECT evidence_count FROM user_preference_memory WHERE label = 'author:save_author'",
        )
        .get(),
    ).toEqual({ evidence_count: 2 });

    applyArticleState({ articleIds: ['state-a'], action: 'unread' });
    const readRow = db
      .prepare(
        "SELECT metadata FROM user_interactions WHERE article_id = 'state-a' AND interaction_type = 'read'",
      )
      .get() as { metadata: string };
    expect(JSON.parse(readRow.metadata).undone_at).toEqual(expect.any(Number));
    expect(
      db
        .prepare(
          "SELECT evidence_count FROM user_preference_memory WHERE label = 'author:save_author'",
        )
        .get(),
    ).toEqual({ evidence_count: 1 });
  });

  it('retracts superseded deltas on reaction switches, supports unthumbs_up, and dispatches thumbs_up webhook', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { dispatchWebhookEvent } = await import('#lib/server/webhooks.ts');
    vi.mocked(dispatchWebhookEvent).mockClear();
    const { applyArticleState, getArticleState } =
      await import('./article-state');
    const db = getDb();
    db.prepare('UPDATE articles SET author = ? WHERE id = ?').run(
      'Reaction Author',
      'state-a',
    );
    const now = Date.now();
    db.prepare(
      'INSERT INTO webhooks (id, url, name, secret, events, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(
      'wh-like',
      'https://hooks.example.com/like',
      'Like Hook',
      null,
      JSON.stringify(['article.thumbs_up']),
      now,
      now,
    );

    const liked = applyArticleState({
      articleIds: ['state-a'],
      action: 'thumbs_up',
    });
    expect(liked.changes[0]?.after.thumbsUp).toBe(true);
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'article.thumbs_up' }),
    );
    expect(
      db
        .prepare(
          "SELECT polarity, evidence_count FROM user_preference_memory WHERE label = 'author:reaction_author'",
        )
        .all(),
    ).toEqual([{ polarity: 'positive', evidence_count: 1 }]);

    // Switching to reject retracts positive thumbs_up delta
    applyArticleState({ articleIds: ['state-a'], action: 'reject' });
    expect(
      db
        .prepare(
          "SELECT polarity, evidence_count FROM user_preference_memory WHERE label = 'author:reaction_author'",
        )
        .all(),
    ).toEqual([{ polarity: 'negative', evidence_count: 1 }]);

    // Switching to boost retracts negative reject delta and unhides
    applyArticleState({ articleIds: ['state-a'], action: 'boost' });
    expect(getArticleState('state-a')).toMatchObject({
      thumbsUp: true,
      thumbsDown: false,
      rejected: false,
      hidden: false,
    });
    expect(
      db
        .prepare(
          "SELECT polarity, evidence_count FROM user_preference_memory WHERE label = 'author:reaction_author'",
        )
        .all(),
    ).toEqual([{ polarity: 'positive', evidence_count: 1 }]);

    // Explicit unthumbs_up clears thumbs_up and retracts boost delta
    applyArticleState({ articleIds: ['state-a'], action: 'unthumbs_up' });
    expect(getArticleState('state-a')?.thumbsUp).toBe(false);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM user_preference_memory WHERE label = 'author:reaction_author'",
        )
        .get(),
    ).toEqual({ c: 0 });
  });

  it('does not bump state_version on no-op writes and restores visibility on unreject/unhide', async () => {
    const { applyArticleState, getArticleState, undoArticleState } =
      await import('./article-state');

    const saved = applyArticleState({
      articleIds: ['state-a'],
      action: 'save',
    });
    const versionAfterSave = getArticleState('state-a')!.stateVersion;

    const noopSave = applyArticleState({
      articleIds: ['state-a'],
      action: 'save',
    });
    expect(noopSave.changes[0]?.changed).toBe(false);
    expect(getArticleState('state-a')!.stateVersion).toBe(versionAfterSave);

    // Earlier undo still succeeds without conflict after no-op write
    const undone = undoArticleState({ operationId: saved.operationId });
    expect(undone.restoredArticleIds).toEqual(['state-a']);

    // unreject clears hidden, unhide clears rejected
    applyArticleState({ articleIds: ['state-a'], action: 'reject' });
    applyArticleState({ articleIds: ['state-a'], action: 'unreject' });
    expect(getArticleState('state-a')).toMatchObject({
      rejected: false,
      thumbsDown: false,
      hidden: false,
    });

    applyArticleState({ articleIds: ['state-a'], action: 'reject' });
    applyArticleState({ articleIds: ['state-a'], action: 'unhide' });
    expect(getArticleState('state-a')).toMatchObject({
      rejected: false,
      thumbsDown: false,
      hidden: false,
    });
  });

  it('guards stale offline replays with queuedAt and paginates recovery endpoints cleanly', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { applyArticleState, getArticleState, ArticleStateError } =
      await import('./article-state');
    const { GET: getStateRecovery } =
      await import('../../routes/api/article-state/recovery/+server');
    const db = getDb();

    // Multi-action offline batch succeeds in chronological order
    applyArticleState({
      articleIds: ['state-a'],
      action: 'save',
      idempotencyKey: 'offline:save-1',
      queuedAt: Date.now() - 2000,
    });
    applyArticleState({
      articleIds: ['state-a'],
      action: 'read',
      idempotencyKey: 'offline:read-1',
      queuedAt: Date.now() - 1000,
    });
    expect(getArticleState('state-a')).toMatchObject({
      saved: true,
      read: true,
    });

    // Newer server mutation blocks older offline replay with 409
    const serverTime = Date.now();
    applyArticleState({
      articleIds: ['state-a'],
      action: 'unsave',
    });
    expect(() =>
      applyArticleState({
        articleIds: ['state-a'],
        action: 'hide',
        idempotencyKey: 'offline:stale-hide',
        queuedAt: serverTime - 5000,
      }),
    ).toThrow(ArticleStateError);
    expect(getArticleState('state-a')?.hidden).toBe(false);

    // Recovery kind=all excludes visible items and honors cursor pagination
    const now = Date.now();
    db.prepare(
      'INSERT INTO articles (id, feed_id, url, title, fetched_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'state-c',
      'feed-state',
      'https://example.com/c',
      'State C',
      now + 10,
      now + 10,
      now + 10,
    );
    applyArticleState({ articleIds: ['state-a'], action: 'hide' });
    applyArticleState({ articleIds: ['state-b'], action: 'reject' });
    // state-c remains visible

    const page1Res = await getStateRecovery({
      url: new URL(
        'http://localhost/api/article-state/recovery?kind=all&limit=1',
      ),
      locals: { sessionId: 'sess' },
    } as never);
    const page1 = (await page1Res.json()) as {
      articles: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(page1.articles).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();

    const page2Res = await getStateRecovery({
      url: new URL(
        `http://localhost/api/article-state/recovery?kind=all&limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      ),
      locals: { sessionId: 'sess' },
    } as never);
    const page2 = (await page2Res.json()) as {
      articles: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(page2.articles).toHaveLength(1);
    expect(
      new Set([...page1.articles, ...page2.articles].map((a) => a.id)),
    ).toEqual(new Set(['state-a', 'state-b']));
    expect(page2.nextCursor).toBeNull();

    const altRecoveryRes = await getStateRecovery({
      url: new URL(
        'http://localhost/api/article-state/recovery?kind=rejected&limit=10',
      ),
      locals: { sessionId: 'sess' },
    } as never);
    const altRecovery = (await altRecoveryRes.json()) as {
      articles: Array<{ id: string }>;
    };
    expect(altRecovery.articles.map((a) => a.id)).toEqual(['state-b']);
  });

  it('surfaces preference_model, manual, and rejected items on page one while excluding 50+ hide_on_open reads and cleared items', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { applyArticleState, listRecoveryArticles, undoArticleState } =
      await import('./article-state');
    const { recordInteraction } = await import('./interactions');
    const { clearFeedArticles } = await import('./feed-management');
    const { GET: getStateRecovery } =
      await import('../../routes/api/article-state/recovery/+server');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('hide_on_open', 'true', ?)",
    ).run(now);
    db.prepare(
      'INSERT INTO feeds (id, url, title, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
    ).run(
      'feed-cleared-only',
      'https://example.com/cleared.xml',
      'Cleared Feed',
      now,
      now,
    );

    const insertArticle = db.prepare(
      `INSERT INTO articles
        (id, feed_id, url, title, hidden, hidden_at, fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Seed a preference_model false positive older than the hide_on_open flood
    insertArticle.run(
      'pref-false-positive',
      'feed-state',
      'https://example.com/pref-fp',
      'Preference Model False Positive',
      1,
      now - 100_000,
      now - 100_000,
      now - 100_000,
      now - 100_000,
    );
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'i-pref-fp',
      'pref-false-positive',
      'hide',
      now - 100_000,
      '{"auto":true,"reason":"preference_model"}',
    );

    // Manual hide on state-a and reject on state-b
    applyArticleState({ articleIds: ['state-a'], action: 'hide' });
    applyArticleState({ articleIds: ['state-b'], action: 'reject' });

    // Cleared feed article must be excluded from recovery items, counts, and feed options
    insertArticle.run(
      'cleared-story',
      'feed-cleared-only',
      'https://example.com/cleared-story',
      'Cleared Story',
      0,
      null,
      now - 50_000,
      now - 50_000,
      now - 50_000,
    );
    clearFeedArticles('feed-cleared-only');

    // Flood with 55 recent hide_on_open reads
    for (let i = 0; i < 55; i += 1) {
      const id = `opened-${i.toString().padStart(2, '0')}`;
      insertArticle.run(
        id,
        'feed-state',
        `https://example.com/${id}`,
        `Opened Story ${i}`,
        0,
        null,
        now + i * 10,
        now + i * 10,
        now + i * 10,
      );
      recordInteraction(id, 'open');
    }

    const defaultRes = await getStateRecovery({
      url: new URL('http://localhost/api/article-state/recovery?limit=50'),
      locals: { sessionId: 'sess' },
    } as never);
    expect(defaultRes.status).toBe(200);
    const defaultPayload = (await defaultRes.json()) as ReturnType<
      typeof listRecoveryArticles
    >;

    expect(defaultPayload.articles.map((item) => item.id)).toEqual(
      expect.arrayContaining(['pref-false-positive', 'state-a', 'state-b']),
    );
    expect(defaultPayload.articles).toHaveLength(3);
    expect(defaultPayload.nextCursor).toBeNull();

    const byId = new Map(
      defaultPayload.articles.map((item) => [item.id, item.hideReason]),
    );
    expect(byId.get('pref-false-positive')).toBe('preference_model');
    expect(byId.get('state-a')).toBe('manual_hide');
    expect(byId.get('state-b')).toBe('rejected');

    expect(defaultPayload.reasonCounts).toEqual({
      actionable: 3,
      all: 58,
      preference_model: 1,
      manual_hide: 1,
      rejected: 1,
      hide_on_open: 55,
    });
    expect(defaultPayload.feeds.map((f) => f.id)).toEqual(['feed-state']);

    // Explicit hide over an earlier auto-hide classifies as manual_hide, and reverts on undo
    const explicitOverAuto = applyArticleState({
      articleIds: ['pref-false-positive'],
      action: 'hide',
    });
    const afterExplicit = listRecoveryArticles({ reason: 'actionable' });
    expect(
      afterExplicit.articles.find((a) => a.id === 'pref-false-positive')
        ?.hideReason,
    ).toBe('manual_hide');
    expect(afterExplicit.reasonCounts).toMatchObject({
      preference_model: 0,
      manual_hide: 2,
    });

    undoArticleState({ operationId: explicitOverAuto.operationId });
    const afterUndoExplicit = listRecoveryArticles({ reason: 'actionable' });
    expect(
      afterUndoExplicit.articles.find((a) => a.id === 'pref-false-positive')
        ?.hideReason,
    ).toBe('preference_model');

    // Open-hidden filter paginates all 55 hide_on_open articles cleanly
    const openPage1 = listRecoveryArticles({
      reason: 'hide_on_open',
      limit: 50,
    });
    expect(openPage1.articles).toHaveLength(50);
    expect(
      openPage1.articles.every((item) => item.hideReason === 'hide_on_open'),
    ).toBe(true);
    expect(openPage1.nextCursor).toBeTruthy();

    const openPage2 = listRecoveryArticles({
      reason: 'hide_on_open',
      limit: 50,
      cursor: openPage1.nextCursor!,
    });
    expect(openPage2.articles).toHaveLength(5);
    expect(openPage2.nextCursor).toBeNull();
  });

  it('filters recovery by paused feeds and normalized FTS5 search queries with cursor pagination', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { GET: getStateRecovery } =
      await import('../../routes/api/article-state/recovery/+server');
    const db = getDb();
    const now = Date.now();

    db.prepare(
      'INSERT INTO feeds (id, url, title, category, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'feed-paused',
      'https://example.com/paused.xml',
      'Paused Science Journal',
      'astrophysics',
      0,
      now,
      now,
    );
    db.prepare(
      'INSERT INTO feeds (id, url, title, category, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'feed-empty',
      'https://example.com/empty.xml',
      'Empty Feed',
      'general',
      1,
      now,
      now,
    );

    const insertDetailed = db.prepare(
      `INSERT INTO articles
        (id, feed_id, url, title, author, summary, content, categories,
         hidden, hidden_at, rejected, thumbs_down, rejected_at,
         fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    insertDetailed.run(
      'rec-title',
      'feed-paused',
      'https://example.com/r1',
      'Supernova neutrino detection',
      'Dr. Vera Rubin',
      'Brief overview.',
      'Body text one.',
      '["cosmos"]',
      1,
      now - 1000,
      0,
      0,
      null,
      now - 1000,
      now,
      now,
    );
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'i-rec-title',
      'rec-title',
      'hide',
      now - 1000,
      '{"auto":true,"reason":"preference_model"}',
    );

    insertDetailed.run(
      'rec-author-content',
      'feed-paused',
      'https://example.com/r2',
      'Telescope calibration report',
      'Subrahmanyan Chandrasekhar',
      ' Summary mentions magnetosphere.',
      'Deep content discussing Node.js telemetry and neutrino bursts.',
      '["instrumentation"]',
      1,
      now - 2000,
      1,
      1,
      now - 2000,
      now - 2000,
      now,
      now,
    );

    insertDetailed.run(
      'rec-open',
      'feed-state',
      'https://example.com/r3',
      'Routine opened neutrino note',
      'Staff Writer',
      'Summary text.',
      'Content text.',
      '["daily"]',
      1,
      now - 3000,
      0,
      0,
      null,
      now - 3000,
      now,
      now,
    );
    db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'i-rec-open',
      'rec-open',
      'hide',
      now - 3000,
      '{"auto":true,"reason":"hide_on_open"}',
    );

    // Paused feed with recovery items appears in feeds list; empty feed does not
    const baseRes = await getStateRecovery({
      url: new URL('http://localhost/api/article-state/recovery'),
      locals: { sessionId: 'sess' },
    } as never);
    const basePayload = (await baseRes.json()) as {
      feeds: Array<{
        id: string;
        title: string;
        enabled: boolean;
        count: number;
      }>;
    };
    const pausedOption = basePayload.feeds.find((f) => f.id === 'feed-paused');
    expect(pausedOption).toEqual({
      id: 'feed-paused',
      title: 'Paused Science Journal',
      enabled: false,
      count: 2,
    });
    expect(
      basePayload.feeds.find((f) => f.id === 'feed-empty'),
    ).toBeUndefined();

    // Search across title/content with cursor pagination and reason=all
    const searchPage1Res = await getStateRecovery({
      url: new URL(
        'http://localhost/api/article-state/recovery?reason=all&q=neutrino&limit=1',
      ),
      locals: { sessionId: 'sess' },
    } as never);
    const searchPage1 = (await searchPage1Res.json()) as {
      articles: Array<{ id: string }>;
      nextCursor: string | null;
      reasonCounts: Record<string, number>;
    };
    expect(searchPage1.articles.map((a) => a.id)).toEqual(['rec-title']);
    expect(searchPage1.reasonCounts).toEqual({
      actionable: 2,
      all: 3,
      preference_model: 1,
      manual_hide: 0,
      rejected: 1,
      hide_on_open: 1,
    });
    expect(searchPage1.nextCursor).toBeTruthy();

    const searchPage2Res = await getStateRecovery({
      url: new URL(
        `http://localhost/api/article-state/recovery?reason=all&q=neutrino&limit=5&cursor=${encodeURIComponent(searchPage1.nextCursor!)}`,
      ),
      locals: { sessionId: 'sess' },
    } as never);
    const searchPage2 = (await searchPage2Res.json()) as {
      articles: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(searchPage2.articles.map((a) => a.id)).toEqual([
      'rec-author-content',
      'rec-open',
    ]);
    expect(searchPage2.nextCursor).toBeNull();

    // Search matches author, summary, feed_title, and category
    for (const [query, expectedIds] of [
      ['Chandrasekhar', ['rec-author-content']],
      ['magnetosphere', ['rec-author-content']],
      ['"Paused Science Journal"', ['rec-title', 'rec-author-content']],
      ['astrophysics', ['rec-title', 'rec-author-content']],
      ['instrumentation', ['rec-author-content']],
      ['Node.js -calibration', []],
      ['-calibration', ['rec-title']],
      ['???', []],
    ] as const) {
      const res = await getStateRecovery({
        url: new URL(
          `http://localhost/api/article-state/recovery?feedId=feed-paused&q=${encodeURIComponent(query)}`,
        ),
        locals: { sessionId: 'sess' },
      } as never);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { articles: Array<{ id: string }> };
      expect(data.articles.map((a) => a.id)).toEqual(expectedIds);
    }

    // Invalid reason returns 400
    const badReason = await getStateRecovery({
      url: new URL('http://localhost/api/article-state/recovery?reason=bogus'),
      locals: { sessionId: 'sess' },
    } as never);
    expect(badReason.status).toBe(400);
  });

  it('atomically restores 500 articles in one batch and reverts the entire batch on undo', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { listRecoveryArticles } = await import('./article-state');
    const { POST: postArticleState } =
      await import('../../routes/api/article-state/+server');
    const { POST: postUndoState } =
      await import('../../routes/api/article-state/undo/+server');
    const db = getDb();
    const now = Date.now();

    const insertArticle = db.prepare(
      `INSERT INTO articles
        (id, feed_id, url, title, hidden, hidden_at, rejected, thumbs_down, rejected_at,
         fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertInteraction = db.prepare(
      'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
    );

    const batchIds: string[] = [];
    db.transaction(() => {
      for (let i = 0; i < 500; i += 1) {
        const id = `bulk-${i.toString().padStart(3, '0')}`;
        batchIds.push(id);
        const ts = now - i * 10;
        const bucket = i % 4;
        const isRejected = bucket === 2 ? 1 : 0;
        insertArticle.run(
          id,
          'feed-state',
          `https://example.com/${id}`,
          `Bulk Recovery ${i}`,
          1,
          ts,
          isRejected,
          isRejected,
          isRejected ? ts : null,
          ts,
          now,
          now,
        );
        if (bucket === 0) {
          insertInteraction.run(
            `i-${id}`,
            id,
            'hide',
            ts,
            '{"auto":true,"reason":"preference_model"}',
          );
        } else if (bucket === 1) {
          insertInteraction.run(`i-${id}`, id, 'hide', ts, '{}');
        } else if (bucket === 2) {
          insertInteraction.run(`i-${id}`, id, 'thumbs_down', ts, '{}');
        } else {
          insertInteraction.run(
            `i-${id}`,
            id,
            'hide',
            ts,
            '{"auto":true,"reason":"hide_on_open"}',
          );
        }
      }
    })();

    const beforeCounts = listRecoveryArticles({ reason: 'all' }).reasonCounts;
    expect(beforeCounts).toEqual({
      actionable: 375,
      all: 500,
      preference_model: 125,
      manual_hide: 125,
      rejected: 125,
      hide_on_open: 125,
    });

    // Rejects > 500 articles
    const tooManyRes = await postArticleState({
      request: new Request('http://localhost/api/article-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          articleIds: [...batchIds, 'extra-501'],
          action: 'restore',
        }),
      }),
      locals: { sessionId: 'sess' },
    } as never);
    expect(tooManyRes.status).toBe(400);

    // Restores 500 articles atomically
    const restoreRes = await postArticleState({
      request: new Request('http://localhost/api/article-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          articleIds: batchIds,
          action: 'restore',
        }),
      }),
      locals: { sessionId: 'sess' },
    } as never);
    expect(restoreRes.status).toBe(200);
    const restoreData = (await restoreRes.json()) as {
      operationId: string;
      changes: Array<{ changed: boolean }>;
    };
    expect(restoreData.changes).toHaveLength(500);
    expect(listRecoveryArticles({ reason: 'all' }).reasonCounts.all).toBe(0);

    // Single undo reverts all 500 articles and preserves their hideReasons
    const undoRes = await postUndoState({
      request: new Request('http://localhost/api/article-state/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: restoreData.operationId }),
      }),
      locals: { sessionId: 'sess' },
    } as never);
    expect(undoRes.status).toBe(200);
    const undoData = (await undoRes.json()) as {
      restoredArticleIds: string[];
      conflicts: string[];
    };
    expect(undoData.restoredArticleIds).toHaveLength(500);
    expect(undoData.conflicts).toEqual([]);
    expect(listRecoveryArticles({ reason: 'all' }).reasonCounts).toEqual(
      beforeCounts,
    );
  });
});
