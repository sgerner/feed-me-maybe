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
