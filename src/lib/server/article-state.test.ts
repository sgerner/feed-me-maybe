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
    const { initializeDatabase } = await import('$lib/server/db/migrate');
    initializeDatabase();
  });

  beforeEach(async () => {
    const { getDb } = await import('$lib/server/db');
    const db = getDb();
    db.prepare('DELETE FROM article_state_history').run();
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
    const { closeDb } = await import('$lib/server/db');
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
});
