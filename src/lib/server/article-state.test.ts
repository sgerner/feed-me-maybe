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
    const { getDb } = await import('$lib/server/db');
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
});
