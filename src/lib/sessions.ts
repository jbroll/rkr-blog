// Server-side sessions. 32-byte random id, stored in `sessions`. Cookie
// attributes (HttpOnly/Secure/SameSite) are set at the route layer.

import crypto from 'node:crypto';

import type { Db } from './db.ts';
import { findUserById, type User } from './users.ts';

export interface Session {
  id: string;
  user_id: number;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
  ip: string | null;
  user_agent: string | null;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_HARD_CAP_MS = 90 * 24 * 60 * 60 * 1000; // 90 days absolute max
const ID_BYTES = 32;

export interface CreateSessionArgs {
  userId: number;
  ip?: string | null;
  userAgent?: string | null;
  ttlMs?: number;
}

export function createSession(db: Db, args: CreateSessionArgs): Session {
  const id = crypto.randomBytes(ID_BYTES).toString('hex');
  const now = Date.now();
  const ttl = args.ttlMs ?? SESSION_TTL_MS;
  const created_at = new Date(now).toISOString();
  const expires_at = new Date(now + ttl).toISOString();

  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    args.userId,
    created_at,
    expires_at,
    created_at,
    args.ip ?? null,
    args.userAgent ?? null
  );

  return {
    id,
    user_id: args.userId,
    created_at,
    expires_at,
    last_seen_at: created_at,
    ip: args.ip ?? null,
    user_agent: args.userAgent ?? null
  };
}

/**
 * Look up a session by id. Returns null when missing OR expired (and prunes
 * expired rows opportunistically).
 */
export function readSession(db: Db, id: string): Session | null {
  const row = db
    .prepare<Session>(
      `SELECT id, user_id, created_at, expires_at, last_seen_at, ip, user_agent
         FROM sessions WHERE id = ?`
    )
    .get(id);
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    deleteSession(db, id);
    return null;
  }
  if (Date.parse(row.created_at) + SESSION_HARD_CAP_MS < Date.now()) {
    deleteSession(db, id);
    return null;
  }
  return row;
}

/** Look up the user associated with a (valid) session. */
export function readSessionUser(db: Db, id: string): { session: Session; user: User } | null {
  const session = readSession(db, id);
  if (!session) return null;
  const user = findUserById(db, session.user_id);
  /* c8 ignore next -- defensive: ON DELETE CASCADE keeps these in lockstep */
  if (!user) return null;
  return { session, user };
}

export function touchSession(db: Db, id: string, when: string = new Date().toISOString()): void {
  const expiresAt = new Date(Date.parse(when) + SESSION_TTL_MS).toISOString();
  db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(
    when,
    expiresAt,
    id
  );
}

export function deleteSession(db: Db, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function deleteUserSessions(db: Db, userId: number): number {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

/** Drop expired session rows. Returns count. */
export function pruneExpired(db: Db, now: Date = new Date()): number {
  return db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString()).changes;
}
