import crypto from 'node:crypto';
import { getDb } from './db';

type AppErrorDetails = Record<string, unknown>;

function serializeError(error: unknown): {
  message: string;
  stack: string;
  name: string;
} {
  if (error instanceof Error) {
    return {
      message: error.message || 'Unknown error',
      stack: error.stack || '',
      name: error.name || 'Error',
    };
  }

  if (typeof error === 'string') {
    return {
      message: error,
      stack: '',
      name: 'Error',
    };
  }

  try {
    return {
      message: JSON.stringify(error),
      stack: '',
      name: 'Error',
    };
  } catch {
    return {
      message: 'Unknown error',
      stack: '',
      name: 'Error',
    };
  }
}

export function recordAppError(input: {
  source: string;
  error: unknown;
  details?: AppErrorDetails;
  path?: string;
  method?: string;
}): void {
  const serialized = serializeError(input.error);
  const details = {
    ...(input.details || {}),
    errorName: serialized.name,
  };

  try {
    const db = getDb();
    db.prepare(
      'INSERT INTO app_error_logs (id, source, message, details, path, method, stack, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      crypto.randomUUID(),
      input.source,
      serialized.message,
      JSON.stringify(details),
      input.path || '',
      input.method || '',
      serialized.stack || '',
      Date.now(),
    );
  } catch (logError) {
    console.error('[logging] Failed to persist application error', logError, {
      source: input.source,
      message: serialized.message,
      details,
    });
  }
}

/** Trim diagnostics without touching reader history or ranking job tombstones. */
export function pruneOperationalHistory(now: number): void {
  const db = getDb();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  db.transaction(() => {
    db.prepare('DELETE FROM app_error_logs WHERE created_at < ?').run(cutoff);
    db.prepare(
      `DELETE FROM feed_fetch_logs
       WHERE status NOT IN ('pending', 'fetching') AND created_at < ?
         AND id NOT IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY feed_id ORDER BY created_at DESC, id DESC) AS newest
             FROM feed_fetch_logs
           ) WHERE newest = 1
           UNION
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY feed_id ORDER BY completed_at DESC, id DESC) AS newest
             FROM feed_fetch_logs WHERE status = 'success'
           ) WHERE newest = 1
         )`,
    ).run(cutoff);
    db.prepare(
      `DELETE FROM jobs WHERE type IN ('feed_fetch', 'ai_process')
         AND status IN ('completed', 'failed') AND completed_at < ?`,
    ).run(cutoff);
  }).immediate();
}
