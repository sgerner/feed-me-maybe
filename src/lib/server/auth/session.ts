import { getDb } from '$lib/server/db';
import crypto from 'node:crypto';

const SESSION_COOKIE_NAME = 'feed-me-maybe-session';
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface Session {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

export function createSession(): Session {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_MS);

  db.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(id, 'admin', now.getTime(), expiresAt.getTime());

  return { id, userId: 'admin', createdAt: now, expiresAt };
}

export function validateSession(sessionId: string): Session | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(sessionId) as Record<string, unknown> | undefined;

  if (!row) return null;

  const session: Session = {
    id: row.id as string,
    userId: row.user_id as string,
    createdAt: new Date(row.created_at as number),
    expiresAt: new Date(row.expires_at as number),
  };

  if (session.expiresAt < new Date()) {
    destroySession(session.id);
    return null;
  }

  return session;
}

export function destroySession(sessionId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

export function setSessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_MS / 1000}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}
