import crypto from 'node:crypto';
import { getDb } from '#lib/server/db/index.ts';
import {
  refreshRankingAfterFeedback,
  refreshRankingAfterProfileMutation,
} from '#lib/server/ranking-freshness.ts';
import {
  hasExplicitHide,
  updateHeuristicScore,
  updatePreferenceMemoryFromInteraction,
  reversePreferenceMemoryDeltas,
  type PreferenceMemoryDelta,
} from '#lib/server/preferences.ts';
import { dispatchWebhookEvent } from '#lib/server/webhooks.ts';

export const ARTICLE_STATE_ACTIONS = [
  'read',
  'unread',
  'save',
  'unsave',
  'hide',
  'unhide',
  'reject',
  'unreject',
  'restore',
  'thumbs_up',
  'boost',
] as const;

export type ArticleStateAction = (typeof ARTICLE_STATE_ACTIONS)[number];
export type ArticleStatePatch = Partial<
  Pick<ArticleState, 'read' | 'saved' | 'hidden' | 'rejected'>
>;
type HistoryAction = ArticleStateAction | 'state_change';

export type ArticleState = {
  read: boolean;
  readAt: number | null;
  saved: boolean;
  savedAt: number | null;
  hidden: boolean;
  hiddenAt: number | null;
  thumbsUp: boolean;
  thumbsDown: boolean;
  rejected: boolean;
  rejectedAt: number | null;
  stateVersion: number;
};

export type StateChange = {
  articleId: string;
  action: HistoryAction;
  changed: boolean;
  before: ArticleState;
  after: ArticleState;
  operationId: string;
  idempotencyKey: string;
  createdAt: number;
  undoneAt: number | null;
};

export type StateMutationResult = {
  operationId: string;
  idempotencyKey: string;
  idempotent: boolean;
  changes: StateChange[];
};

export type UndoResult = {
  operationId: string;
  idempotencyKey: string;
  alreadyUndone: boolean;
  restoredArticleIds: string[];
  conflicts: string[];
};

export class ArticleStateError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ArticleStateError';
    this.status = status;
  }
}

type RawArticleState = {
  id: string;
  read: number;
  read_at: number | null;
  saved: number;
  saved_at: number | null;
  hidden: number;
  hidden_at: number | null;
  thumbs_up: number;
  thumbs_down: number;
  rejected: number;
  rejected_at: number | null;
  state_version: number;
};

type HistoryRow = {
  id: string;
  operation_id: string;
  idempotency_key: string;
  article_id: string;
  action: HistoryAction;
  before_state: string;
  after_state: string;
  created_at: number;
  undone_at: number | null;
};

type InteractionFeedbackRow = {
  id: string;
  timestamp: number;
  metadata: string | null;
};

function interactionMetadata(
  operationId: string,
  idempotencyKey: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    operation_id: operationId,
    idempotency_key: idempotencyKey,
    ...extra,
  });
}

function parseInteractionMetadata(
  value: string | null,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function activeOperationForAction(
  articleId: string,
  action: 'hide' | 'reject',
): string | null {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT operation_id, before_state, after_state
       FROM article_state_history
       WHERE article_id = ? AND action = ? AND undone_at IS NULL
       ORDER BY created_at DESC, id DESC`,
    )
    .all(articleId, action) as Array<{
    operation_id: string;
    before_state: string;
    after_state: string;
  }>;
  const hasActiveInteraction = db.prepare(
    `SELECT 1 FROM user_interactions
     WHERE article_id = ?
       AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.operation_id') = ?
       AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.undone_at') IS NULL
       AND interaction_type = ?
     LIMIT 1`,
  );

  for (const row of rows) {
    const before = parseState(row.before_state);
    const after = parseState(row.after_state);
    const changedFlag =
      action === 'hide'
        ? (!before.hidden && after.hidden) ||
          (before.hidden && after.hidden && before.hiddenAt !== after.hiddenAt)
        : !before.rejected && after.rejected;
    if (!changedFlag) continue;
    const interactionType = action === 'hide' ? 'hide' : 'thumbs_down';
    if (
      hasActiveInteraction.get(articleId, row.operation_id, interactionType)
    ) {
      return row.operation_id;
    }
  }
  return null;
}

function markOperationInteractionsUndone(
  articleId: string,
  operationId: string,
  undoOperationId: string,
  now: number,
): boolean {
  const db = getDb();
  const events = db
    .prepare(
      `SELECT id, timestamp, metadata FROM user_interactions
       WHERE article_id = ?
         AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.operation_id') = ?
         AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.undone_at') IS NULL`,
    )
    .all(articleId, operationId) as InteractionFeedbackRow[];
  if (!events.length) return false;

  const update = db.prepare(
    `UPDATE user_interactions
     SET metadata = json_set(
       CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,
       '$.undone_at', ?, '$.undo_operation_id', ?
     ) WHERE id = ?`,
  );
  for (const event of events) {
    const metadata = parseInteractionMetadata(event.metadata);
    reversePreferenceMemoryDeltas(
      metadata.preference_deltas,
      Number(event.timestamp),
    );
    update.run(now, undoOperationId, event.id);
  }
  return true;
}

function undoOperationsForAction(
  articleId: string,
  action: ArticleStateAction,
  before: ArticleState,
): string[] {
  const actions: Array<'hide' | 'reject'> = [];
  if ((action === 'unhide' || action === 'restore') && before.hidden) {
    actions.push('hide');
  }
  if ((action === 'unreject' || action === 'restore') && before.rejected) {
    actions.push('reject');
  }
  return actions
    .map((priorAction) => activeOperationForAction(articleId, priorAction))
    .filter((operationId): operationId is string => Boolean(operationId));
}

function toState(row: RawArticleState): ArticleState {
  return {
    read: Boolean(row.read),
    readAt: row.read_at === null ? null : Number(row.read_at),
    saved: Boolean(row.saved),
    savedAt: row.saved_at === null ? null : Number(row.saved_at),
    hidden: Boolean(row.hidden),
    hiddenAt: row.hidden_at === null ? null : Number(row.hidden_at),
    thumbsUp: Boolean(row.thumbs_up),
    thumbsDown: Boolean(row.thumbs_down),
    rejected: Boolean(row.rejected) || Boolean(row.thumbs_down),
    rejectedAt: row.rejected_at === null ? null : Number(row.rejected_at),
    stateVersion: Number(row.state_version || 0),
  };
}

function getState(articleId: string): ArticleState {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT id, read, read_at, saved, saved_at, hidden, hidden_at,
             thumbs_up, thumbs_down, rejected, rejected_at, state_version
      FROM articles WHERE id = ?
    `,
    )
    .get(articleId) as RawArticleState | undefined;
  if (!row) throw new ArticleStateError('Article not found', 404);
  return toState(row);
}

export function getArticleState(articleId: string): ArticleState | null {
  try {
    return getState(articleId);
  } catch (error: unknown) {
    if (error instanceof ArticleStateError && error.status === 404) return null;
    throw error;
  }
}

function sameState(a: ArticleState, b: ArticleState): boolean {
  return (
    a.read === b.read &&
    a.readAt === b.readAt &&
    a.saved === b.saved &&
    a.savedAt === b.savedAt &&
    a.hidden === b.hidden &&
    a.hiddenAt === b.hiddenAt &&
    a.thumbsUp === b.thumbsUp &&
    a.thumbsDown === b.thumbsDown &&
    a.rejected === b.rejected &&
    a.rejectedAt === b.rejectedAt
  );
}

function stateAfterAction(
  before: ArticleState,
  action: HistoryAction,
  now: number,
  patch: ArticleStatePatch = {},
): ArticleState {
  const after = { ...before };
  switch (action) {
    case 'read':
      after.read = true;
      after.readAt ??= now;
      break;
    case 'unread':
      after.read = false;
      after.readAt = null;
      break;
    case 'save':
      after.saved = true;
      after.savedAt ??= now;
      break;
    case 'unsave':
      after.saved = false;
      after.savedAt = null;
      break;
    case 'hide':
      after.hidden = true;
      after.hiddenAt ??= now;
      break;
    case 'unhide':
      after.hidden = false;
      after.hiddenAt = null;
      break;
    case 'reject':
      after.thumbsUp = false;
      after.thumbsDown = true;
      after.rejected = true;
      after.rejectedAt ??= now;
      after.hidden = true;
      after.hiddenAt ??= now;
      break;
    case 'unreject':
      after.thumbsDown = false;
      after.rejected = false;
      after.rejectedAt = null;
      break;
    case 'restore':
      after.hidden = false;
      after.hiddenAt = null;
      after.thumbsDown = false;
      after.rejected = false;
      after.rejectedAt = null;
      break;
    case 'thumbs_up':
      after.thumbsUp = true;
      after.thumbsDown = false;
      after.rejected = false;
      after.rejectedAt = null;
      break;
    case 'boost':
      after.thumbsUp = true;
      after.thumbsDown = false;
      after.rejected = false;
      after.rejectedAt = null;
      after.hidden = false;
      after.hiddenAt = null;
      break;
    case 'state_change':
      if (patch.read !== undefined) {
        after.read = patch.read;
        after.readAt = patch.read ? (after.readAt ?? now) : null;
      }
      if (patch.saved !== undefined) {
        after.saved = patch.saved;
        after.savedAt = patch.saved ? (after.savedAt ?? now) : null;
      }
      if (patch.hidden !== undefined) {
        after.hidden = patch.hidden;
        after.hiddenAt = patch.hidden ? (after.hiddenAt ?? now) : null;
      }
      if (patch.rejected !== undefined) {
        after.rejected = patch.rejected;
        after.thumbsDown = patch.rejected;
        after.rejectedAt = patch.rejected ? (after.rejectedAt ?? now) : null;
      }
      break;
  }
  return after;
}

function parseState(value: string): ArticleState {
  try {
    const parsed = JSON.parse(value) as Partial<ArticleState>;
    if (
      typeof parsed.read !== 'boolean' ||
      typeof parsed.saved !== 'boolean' ||
      typeof parsed.hidden !== 'boolean' ||
      typeof parsed.thumbsUp !== 'boolean' ||
      typeof parsed.thumbsDown !== 'boolean' ||
      typeof parsed.rejected !== 'boolean' ||
      typeof parsed.stateVersion !== 'number'
    ) {
      throw new Error('invalid state');
    }
    return {
      read: parsed.read,
      readAt: parsed.readAt ?? null,
      saved: parsed.saved,
      savedAt: parsed.savedAt ?? null,
      hidden: parsed.hidden,
      hiddenAt: parsed.hiddenAt ?? null,
      thumbsUp: parsed.thumbsUp,
      thumbsDown: parsed.thumbsDown,
      rejected: parsed.rejected,
      rejectedAt: parsed.rejectedAt ?? null,
      stateVersion: parsed.stateVersion,
    };
  } catch {
    throw new ArticleStateError('Corrupt article state history', 500);
  }
}

function normalizeArticleIds(articleIds: string[]): string[] {
  const unique = [
    ...new Set(articleIds.map((id) => id.trim()).filter(Boolean)),
  ];
  if (unique.length === 0) {
    throw new ArticleStateError('At least one articleId is required');
  }
  if (unique.length > 500) {
    throw new ArticleStateError(
      'A state operation can contain at most 500 articles',
    );
  }
  if (unique.some((id) => id.length > 200)) {
    throw new ArticleStateError('Invalid articleId');
  }
  return unique;
}

function normalizeIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() || crypto.randomUUID();
  if (key.length < 1 || key.length > 200) {
    throw new ArticleStateError(
      'Idempotency key must be between 1 and 200 characters',
    );
  }
  return key;
}

function mapHistoryRow(row: HistoryRow): StateChange {
  const before = parseState(row.before_state);
  const after = parseState(row.after_state);
  return {
    articleId: row.article_id,
    action: row.action,
    changed: !sameState(before, after),
    before,
    after,
    operationId: row.operation_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    undoneAt: row.undone_at,
  };
}

function existingMutation(
  idempotencyKey: string,
  action: HistoryAction,
): StateMutationResult | null {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, operation_id, idempotency_key, article_id, action,
              before_state, after_state, created_at, undone_at
       FROM article_state_history
       WHERE idempotency_key = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(idempotencyKey) as HistoryRow[];
  if (rows.length === 0) return null;
  if (rows.some((row) => row.action !== action)) {
    throw new ArticleStateError(
      'Idempotency key was already used for a different state action',
      409,
    );
  }
  return {
    operationId: rows[0].operation_id,
    idempotencyKey,
    idempotent: true,
    changes: rows.map(mapHistoryRow),
  };
}

type ArticleStateMutationInput = {
  articleIds: string[];
  action: ArticleStateAction;
  idempotencyKey?: string;
  visibleArticleIds?: unknown;
};

export function applyArticleState(
  input: ArticleStateMutationInput,
): StateMutationResult;
export function applyArticleState(
  articleIds: string[],
  patch: ArticleStatePatch,
  options?: {
    action?: string;
    idempotencyKey?: string;
    visibleArticleIds?: unknown;
  },
): StateMutationResult;
export function applyArticleState(
  inputOrArticleIds: ArticleStateMutationInput | string[],
  patch: ArticleStatePatch = {},
  options: {
    action?: string;
    idempotencyKey?: string;
    visibleArticleIds?: unknown;
  } = {},
): StateMutationResult {
  const input: {
    articleIds: string[];
    action: HistoryAction;
    idempotencyKey?: string;
    visibleArticleIds?: unknown;
    patch?: ArticleStatePatch;
  } = Array.isArray(inputOrArticleIds)
    ? {
        articleIds: inputOrArticleIds,
        action:
          options.action === 'state_change' ||
          (typeof options.action === 'string' &&
            ARTICLE_STATE_ACTIONS.includes(
              options.action as ArticleStateAction,
            ))
            ? (options.action as HistoryAction)
            : 'state_change',
        idempotencyKey: options.idempotencyKey,
        visibleArticleIds: options.visibleArticleIds,
        patch,
      }
    : inputOrArticleIds;

  if (
    input.action !== 'state_change' &&
    !ARTICLE_STATE_ACTIONS.includes(input.action)
  ) {
    throw new ArticleStateError('Unsupported article state action');
  }
  const articleIds = normalizeArticleIds(input.articleIds);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const replay = existingMutation(idempotencyKey, input.action);
  if (replay) return replay;

  const db = getDb();
  const operationId = crypto.randomUUID();
  const now = Date.now();
  const changes = db.transaction(() => {
    const output: StateChange[] = [];
    const update = db.prepare(`
      UPDATE articles SET
        read = ?, read_at = ?, saved = ?, saved_at = ?, hidden = ?, hidden_at = ?,
        thumbs_up = ?, thumbs_down = ?, rejected = ?, rejected_at = ?,
        cleared_at = CASE WHEN ? = 1 THEN NULL ELSE cleared_at END,
        state_version = state_version + 1, updated_at = ?
      WHERE id = ?
    `);
    const insertHistory = db.prepare(`
      INSERT INTO article_state_history
        (id, operation_id, idempotency_key, article_id, action, before_state, after_state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const articleId of articleIds) {
      const before = getState(articleId);
      const next = stateAfterAction(before, input.action, now, input.patch);
      // A model or hide-on-open may already have set hidden=1. A user's
      // explicit Hide still needs a reversible state change so its preference
      // delta and heuristic penalty are recorded independently.
      if (
        input.action === 'hide' &&
        before.hidden &&
        !hasExplicitHide(articleId)
      ) {
        next.hiddenAt = Math.max(now, (before.hiddenAt ?? 0) + 1);
      }
      update.run(
        next.read ? 1 : 0,
        next.readAt,
        next.saved ? 1 : 0,
        next.savedAt,
        next.hidden ? 1 : 0,
        next.hiddenAt,
        next.thumbsUp ? 1 : 0,
        next.thumbsDown ? 1 : 0,
        next.rejected ? 1 : 0,
        next.rejectedAt,
        !next.hidden || input.action === 'reject' ? 1 : 0,
        now,
        articleId,
      );
      // Compatibility triggers can fill missing timestamps on older rows.
      const after = getState(articleId);
      insertHistory.run(
        crypto.randomUUID(),
        operationId,
        idempotencyKey,
        articleId,
        input.action,
        JSON.stringify(before),
        JSON.stringify(after),
        now,
      );
      output.push({
        articleId,
        action: input.action,
        changed: !sameState(before, after),
        before,
        after,
        operationId,
        idempotencyKey,
        createdAt: now,
        undoneAt: null,
      });
    }

    const undoneOperations = new Map<string, string[]>();
    for (const change of output) {
      if (
        !change.changed ||
        !ARTICLE_STATE_ACTIONS.includes(change.action as ArticleStateAction)
      ) {
        continue;
      }
      const undoOperationIds = undoOperationsForAction(
        change.articleId,
        change.action as ArticleStateAction,
        change.before,
      );
      for (const priorOperationId of undoOperationIds) {
        markOperationInteractionsUndone(
          change.articleId,
          priorOperationId,
          operationId,
          now,
        );
      }
      if (undoOperationIds.length) {
        undoneOperations.set(change.articleId, undoOperationIds);
      }
    }

    const feedbackType =
      input.action === 'reject'
        ? 'thumbs_down'
        : input.action === 'thumbs_up' || input.action === 'boost'
          ? input.action
          : null;
    if (feedbackType) {
      const changedArticleIds = output
        .filter((change) => change.changed)
        .map((change) => change.articleId);
      if (changedArticleIds.length) {
        // Keep preference learning and its durable refresh marker atomic with
        // the idempotent state mutation, so a replay can never lose the vote.
        refreshRankingAfterFeedback({
          articleIds: changedArticleIds,
          type: feedbackType,
          visibleArticleIds: input.visibleArticleIds,
          operationId,
          idempotencyKey,
        });
      }
    }
    if (
      input.action === 'read' ||
      input.action === 'save' ||
      input.action === 'hide'
    ) {
      const insertInteraction = db.prepare(
        'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
      );
      for (const change of output) {
        if (!change.changed) continue;
        const preferenceDeltas: PreferenceMemoryDelta[] = [];
        updatePreferenceMemoryFromInteraction(
          change.articleId,
          input.action,
          preferenceDeltas,
        );
        insertInteraction.run(
          crypto.randomUUID(),
          change.articleId,
          input.action,
          now,
          interactionMetadata(operationId, idempotencyKey, {
            preference_deltas: preferenceDeltas,
          }),
        );
        refreshRankingAfterProfileMutation(change.articleId);
      }
    } else if (
      input.action === 'unread' ||
      input.action === 'unsave' ||
      input.action === 'unhide' ||
      input.action === 'unreject' ||
      input.action === 'restore'
    ) {
      const insertInteraction = db.prepare(
        'INSERT INTO user_interactions (id, article_id, interaction_type, timestamp, metadata) VALUES (?, ?, ?, ?, ?)',
      );
      for (const change of output) {
        if (!change.changed) continue;
        insertInteraction.run(
          crypto.randomUUID(),
          change.articleId,
          input.action,
          now,
          interactionMetadata(operationId, idempotencyKey, {
            undo_of_operation_ids: undoneOperations.get(change.articleId) || [],
          }),
        );
        if (
          input.action === 'unhide' ||
          input.action === 'unreject' ||
          input.action === 'restore'
        ) {
          refreshRankingAfterProfileMutation(change.articleId);
        } else {
          updateHeuristicScore(change.articleId);
        }
      }
    } else if (input.action === 'state_change') {
      for (const change of output) {
        if (!change.changed) continue;
        if (change.before.hidden && !change.after.hidden) {
          for (const priorOperationId of undoOperationsForAction(
            change.articleId,
            'unhide',
            change.before,
          )) {
            markOperationInteractionsUndone(
              change.articleId,
              priorOperationId,
              operationId,
              now,
            );
          }
        }
        if (change.before.rejected && !change.after.rejected) {
          for (const priorOperationId of undoOperationsForAction(
            change.articleId,
            'unreject',
            change.before,
          )) {
            markOperationInteractionsUndone(
              change.articleId,
              priorOperationId,
              operationId,
              now,
            );
          }
        }
        if (
          (change.before.hidden && !change.after.hidden) ||
          (change.before.rejected && !change.after.rejected)
        ) {
          refreshRankingAfterProfileMutation(change.articleId);
        } else {
          updateHeuristicScore(change.articleId);
        }
      }
    }
    return output;
  })();

  if (input.action === 'read' || input.action === 'save') {
    const selectArticle = db.prepare('SELECT * FROM articles WHERE id = ?');
    for (const change of changes) {
      if (!change.changed) continue;
      const article = selectArticle.get(change.articleId);
      if (article) {
        dispatchWebhookEvent({
          type: input.action === 'read' ? 'article.read' : 'article.saved',
          timestamp: now,
          payload: { article },
        });
      }
    }
  }
  return { operationId, idempotencyKey, idempotent: false, changes };
}

export function undoArticleState(input: {
  operationId?: string;
  idempotencyKey?: string;
}): UndoResult;
export function undoArticleState(operationId: string): UndoResult;
export function undoArticleState(
  input: { operationId?: string; idempotencyKey?: string } | string,
): UndoResult {
  const operationId =
    typeof input === 'string' ? input.trim() : input.operationId?.trim();
  const idempotencyKey =
    typeof input === 'string' ? undefined : input.idempotencyKey?.trim();
  if (!operationId && !idempotencyKey) {
    throw new ArticleStateError('operationId or idempotencyKey is required');
  }

  const db = getDb();
  const where = operationId ? 'operation_id = ?' : 'idempotency_key = ?';
  const value = operationId || idempotencyKey;
  const rows = db
    .prepare(
      `SELECT id, operation_id, idempotency_key, article_id, action,
              before_state, after_state, created_at, undone_at
       FROM article_state_history WHERE ${where}
       ORDER BY created_at ASC, id ASC`,
    )
    .all(value) as HistoryRow[];
  if (rows.length === 0) {
    throw new ArticleStateError('State operation not found', 404);
  }

  if (rows.every((row) => row.undone_at !== null)) {
    return {
      operationId: rows[0].operation_id,
      idempotencyKey: rows[0].idempotency_key,
      alreadyUndone: true,
      restoredArticleIds: [],
      conflicts: [],
    };
  }

  const undoOperationId = crypto.randomUUID();
  const restoredArticleIds = db.transaction(() => {
    const restored: string[] = [];
    const markUndone = db.prepare(
      'UPDATE article_state_history SET undone_at = ? WHERE id = ?',
    );
    const restore = db.prepare(`
      UPDATE articles SET
        read = ?, read_at = ?, saved = ?, saved_at = ?, hidden = ?, hidden_at = ?,
        thumbs_up = ?, thumbs_down = ?, rejected = ?, rejected_at = ?,
        cleared_at = CASE WHEN ? = 1 THEN NULL ELSE cleared_at END,
        state_version = state_version + 1, updated_at = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      if (row.undone_at !== null) continue;
      const before = parseState(row.before_state);
      const after = parseState(row.after_state);
      const current = getState(row.article_id);
      if (
        current.stateVersion !== after.stateVersion ||
        !sameState(current, after)
      )
        continue;
      restore.run(
        before.read ? 1 : 0,
        before.readAt,
        before.saved ? 1 : 0,
        before.savedAt,
        before.hidden ? 1 : 0,
        before.hiddenAt,
        before.thumbsUp ? 1 : 0,
        before.thumbsDown ? 1 : 0,
        before.rejected ? 1 : 0,
        before.rejectedAt,
        before.hidden ? 0 : 1,
        Date.now(),
        row.article_id,
      );
      markUndone.run(Date.now(), row.id);
      markOperationInteractionsUndone(
        row.article_id,
        row.operation_id,
        undoOperationId,
        Date.now(),
      );
      refreshRankingAfterProfileMutation(row.article_id);
      restored.push(row.article_id);
    }
    return restored;
  })();

  const conflicts = rows
    .filter(
      (row) =>
        row.undone_at === null && !restoredArticleIds.includes(row.article_id),
    )
    .map((row) => row.article_id);

  return {
    operationId: rows[0].operation_id,
    idempotencyKey: rows[0].idempotency_key,
    alreadyUndone: false,
    restoredArticleIds,
    conflicts: [...new Set(conflicts)],
  };
}

export function getArticleStateHistory(
  options: {
    articleId?: string;
    limit?: number;
  } = {},
): StateChange[] {
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit || 50)));
  const db = getDb();
  const rows = options.articleId
    ? db
        .prepare(
          `SELECT id, operation_id, idempotency_key, article_id, action,
                  before_state, after_state, created_at, undone_at
           FROM article_state_history WHERE article_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(options.articleId, limit)
    : db
        .prepare(
          `SELECT id, operation_id, idempotency_key, article_id, action,
                  before_state, after_state, created_at, undone_at
           FROM article_state_history
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(limit);
  return (rows as HistoryRow[]).map(mapHistoryRow);
}

export type UnreadCounts = {
  totalUnread: number;
  visibleUnread: number;
  hiddenUnread: number;
  savedUnread: number;
  rejectedUnread: number;
  feeds: Array<{
    feedId: string;
    feedTitle: string;
    category: string;
    unread: number;
    visibleUnread: number;
    hiddenUnread: number;
  }>;
};

export function getUnreadCounts(): UnreadCounts {
  const db = getDb();
  const totals = db
    .prepare(
      `
      SELECT
        COALESCE(SUM(CASE WHEN a.read = 0 THEN 1 ELSE 0 END), 0) AS total_unread,
        COALESCE(SUM(CASE WHEN a.read = 0 AND a.hidden = 0 THEN 1 ELSE 0 END), 0) AS visible_unread,
        COALESCE(SUM(CASE WHEN a.read = 0 AND a.hidden = 1 THEN 1 ELSE 0 END), 0) AS hidden_unread,
        COALESCE(SUM(CASE WHEN a.read = 0 AND a.saved = 1 THEN 1 ELSE 0 END), 0) AS saved_unread,
        COALESCE(SUM(CASE WHEN a.read = 0 AND (a.thumbs_down = 1 OR a.rejected = 1) THEN 1 ELSE 0 END), 0) AS rejected_unread
      FROM articles a
    `,
    )
    .get() as Record<string, number>;
  const feeds = db
    .prepare(
      `
      SELECT f.id AS feed_id, COALESCE(f.title, '') AS feed_title,
             COALESCE(f.category, '') AS category,
             COALESCE(SUM(CASE WHEN a.read = 0 THEN 1 ELSE 0 END), 0) AS unread,
             COALESCE(SUM(CASE WHEN a.read = 0 AND a.hidden = 0 THEN 1 ELSE 0 END), 0) AS visible_unread,
             COALESCE(SUM(CASE WHEN a.read = 0 AND a.hidden = 1 THEN 1 ELSE 0 END), 0) AS hidden_unread
      FROM feeds f LEFT JOIN articles a ON a.feed_id = f.id
      GROUP BY f.id, f.title, f.category
      HAVING unread > 0
      ORDER BY unread DESC, lower(feed_title) ASC
    `,
    )
    .all() as Array<Record<string, string | number>>;

  return {
    totalUnread: Number(totals.total_unread || 0),
    visibleUnread: Number(totals.visible_unread || 0),
    hiddenUnread: Number(totals.hidden_unread || 0),
    savedUnread: Number(totals.saved_unread || 0),
    rejectedUnread: Number(totals.rejected_unread || 0),
    feeds: feeds.map((feed) => ({
      feedId: String(feed.feed_id),
      feedTitle: String(feed.feed_title || ''),
      category: String(feed.category || ''),
      unread: Number(feed.unread || 0),
      visibleUnread: Number(feed.visible_unread || 0),
      hiddenUnread: Number(feed.hidden_unread || 0),
    })),
  };
}

export type ArticleStateCounts = {
  total: number;
  unread: number;
  read: number;
  saved: number;
  hidden: number;
  rejected: number;
};

export function getArticleStateCounts(feedId?: string): ArticleStateCounts {
  const db = getDb();
  const where = feedId ? 'WHERE feed_id = ?' : '';
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END), 0) AS unread,
             COALESCE(SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END), 0) AS read,
             COALESCE(SUM(CASE WHEN saved = 1 THEN 1 ELSE 0 END), 0) AS saved,
             COALESCE(SUM(CASE WHEN hidden = 1 THEN 1 ELSE 0 END), 0) AS hidden,
             COALESCE(SUM(CASE WHEN rejected = 1 OR thumbs_down = 1 THEN 1 ELSE 0 END), 0) AS rejected
      FROM articles
      ${where}
    `,
    )
    .get(...(feedId ? [feedId] : [])) as Record<string, number>;
  return {
    total: Number(row.total || 0),
    unread: Number(row.unread || 0),
    read: Number(row.read || 0),
    saved: Number(row.saved || 0),
    hidden: Number(row.hidden || 0),
    rejected: Number(row.rejected || 0),
  };
}

export type RecoveryArticle = ArticleState & {
  id: string;
  title: string;
  url: string;
  feedId: string;
  feedTitle: string;
  stateChangedAt: number | null;
};

type RecoveryCursor = { timestamp: number; id: string };

function decodeRecoveryCursor(value: string): RecoveryCursor {
  try {
    const cursor = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as RecoveryCursor;
    if (!Number.isFinite(cursor.timestamp) || !cursor.id)
      throw new Error('invalid');
    return cursor;
  } catch {
    throw new ArticleStateError('Invalid recovery cursor');
  }
}

export function listRecoveryArticles(
  options: {
    limit?: number;
    cursor?: string;
    feedId?: string;
  } = {},
): { articles: RecoveryArticle[]; nextCursor: string | null } {
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit || 25)));
  const params: Array<string | number> = [];
  let where =
    'WHERE a.cleared_at IS NULL AND (a.hidden = 1 OR a.rejected = 1 OR a.thumbs_down = 1)';
  if (options.feedId) {
    where += ' AND a.feed_id = ?';
    params.push(options.feedId);
  }
  if (options.cursor) {
    const cursor = decodeRecoveryCursor(options.cursor);
    const stateChangedAt = 'COALESCE(a.hidden_at, a.rejected_at, a.fetched_at)';
    where += ` AND (${stateChangedAt} < ? OR (${stateChangedAt} = ? AND a.id < ?))`;
    params.push(cursor.timestamp, cursor.timestamp, cursor.id);
  }

  const rows = getDb()
    .prepare(
      `
      SELECT a.id, a.title, a.url, a.feed_id, COALESCE(f.title, '') AS feed_title,
             a.read, a.read_at, a.saved, a.saved_at, a.hidden, a.hidden_at,
             a.thumbs_up, a.thumbs_down, a.rejected, a.rejected_at, a.state_version,
             COALESCE(a.hidden_at, a.rejected_at, a.fetched_at) AS state_changed_at
      FROM articles a JOIN feeds f ON f.id = a.feed_id
      ${where}
      ORDER BY COALESCE(a.hidden_at, a.rejected_at, a.fetched_at) DESC, a.id DESC
      LIMIT ?
    `,
    )
    .all(...params, limit + 1) as Array<
    RawArticleState & {
      title: string;
      url: string;
      feed_id: string;
      feed_title: string;
      state_changed_at: number | null;
    }
  >;
  const hasMore = rows.length > limit;
  const resultRows = hasMore ? rows.slice(0, limit) : rows;
  const articles = resultRows.map((row) => ({
    id: row.id,
    title: row.title,
    url: row.url,
    feedId: row.feed_id,
    feedTitle: row.feed_title,
    ...toState(row),
    stateChangedAt: row.state_changed_at,
  }));
  const last = resultRows.at(-1);
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({
            timestamp:
              last.state_changed_at ?? last.hidden_at ?? last.rejected_at ?? 0,
            id: last.id,
          }),
        ).toString('base64url')
      : null;
  return { articles, nextCursor };
}

export function listStateHistory(
  options: {
    articleId?: string;
    limit?: number;
  } = {},
): StateChange[] {
  return getArticleStateHistory(options);
}
