import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

describe('article state foundation', () => {
  const testDbPath = join(process.cwd(), 'data', 'test-article-state.db');
  const originalDbUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDbPath;
    const dataDir = join(process.cwd(), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const { initializeDatabase } = await import('#lib/server/db/migrate.ts');
    initializeDatabase();
  });

  beforeEach(async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const db = getDb();
    db.prepare('DELETE FROM article_state_history').run();
    db.prepare('DELETE FROM user_interactions').run();
    db.prepare('DELETE FROM user_preference_memory').run();
    db.prepare('DELETE FROM ranking_refresh_queue').run();
    db.prepare('DELETE FROM jobs').run();
    db.prepare('DELETE FROM articles').run();
    db.prepare('DELETE FROM feeds').run();
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

  afterAll(async () => {
    const { closeDb } = await import('#lib/server/db/index.ts');
    closeDb();
    process.env.DATABASE_URL = originalDbUrl ?? '';
    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${testDbPath}${suffix}`;
      if (existsSync(path)) unlinkSync(path);
    }
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

  it('excludes paused feeds from unread and state counts', async () => {
    const { getDb } = await import('#lib/server/db/index.ts');
    const { getUnreadCounts, getArticleStateCounts } =
      await import('./article-state');
    const db = getDb();
    const beforeUnread = getUnreadCounts();
    const beforeState = getArticleStateCounts();
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
    const stateCounts = getArticleStateCounts();
    expect(stateCounts.total).toBe(beforeState.total);
    expect(getArticleStateCounts('feed-paused').total).toBe(0);
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
    const { GET: getArticlesRecovery } =
      await import('../../routes/api/articles/state/recovery/+server');
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

    const page1Res = await getArticlesRecovery({
      url: new URL(
        'http://localhost/api/articles/state/recovery?kind=all&limit=1',
      ),
      locals: { sessionId: 'sess' },
    } as never);
    const page1 = (await page1Res.json()) as {
      articles: Array<{ id: string }>;
      nextCursor: string | null;
      total: number;
    };
    expect(page1.total).toBe(2);
    expect(page1.articles).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();

    const page2Res = await getArticlesRecovery({
      url: new URL(
        `http://localhost/api/articles/state/recovery?kind=all&limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`,
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
});
