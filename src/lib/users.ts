// Users + OAuth-account links + invite allowlist.
//
// findOrCreateOAuthUser is the entry point from the auth callback: given a
// (provider, sub, email) triple, it either returns an existing user or
// creates one — but only if the email is on the invite allowlist.

import type { Db } from './db.ts';

export type Role = 'owner' | 'editor';

export interface User {
  id: number;
  email: string;
  display_name: string | null;
  role: Role;
  created_at: string;
  last_seen_at: string | null;
}

export interface AllowedEmail {
  email: string;
  role: Role;
  invited_at: string;
  invited_by: number | null;
}

export interface OAuthIdentity {
  provider: string; // 'google'
  sub: string; // provider's stable subject id
  email: string;
  displayName?: string | null;
}

export class NotInvitedError extends Error {
  constructor(email: string) {
    super(`email not invited: ${email}`);
    this.name = 'NotInvitedError';
  }
}

/**
 * Thrown when a fresh OAuth login (no matching oauth_accounts row)
 * presents an email that belongs to an existing user via a *different*
 * provider. Without this guard, anyone who controls victim@gmail.com
 * on a newly-supported provider could inherit the existing user's role
 * by silent linking. Real cross-provider linking must be authenticated
 * (initiated from an existing session) — there's no UI for that yet,
 * so we reject here.
 */
export class EmailLinkedError extends Error {
  constructor(email: string) {
    super(`email already linked to another provider: ${email}`);
    this.name = 'EmailLinkedError';
  }
}

/** NFKC + lowercase. NFKC collapses visually-identical Unicode forms
 * (e.g. `İ` vs `i̇`) so allowlist comparisons can't be bypassed
 * via a different code-point sequence. */
function normalizeEmail(email: string): string {
  return email.normalize('NFKC').toLowerCase();
}

// ---- users -------------------------------------------------------------

export function findUserByEmail(db: Db, email: string): User | undefined {
  return db
    .prepare<User>(
      'SELECT id, email, display_name, role, created_at, last_seen_at FROM users WHERE email = ?'
    )
    .get(normalizeEmail(email));
}

export function findUserById(db: Db, id: number): User | undefined {
  return db
    .prepare<User>(
      'SELECT id, email, display_name, role, created_at, last_seen_at FROM users WHERE id = ?'
    )
    .get(id);
}

export function listUsers(db: Db): User[] {
  return db
    .prepare<User>(
      'SELECT id, email, display_name, role, created_at, last_seen_at FROM users ORDER BY created_at'
    )
    .all();
}

export function touchLastSeen(
  db: Db,
  userId: number,
  when: string = new Date().toISOString()
): void {
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(when, userId);
}

// ---- oauth_accounts ----------------------------------------------------

interface OAuthAccountRow {
  user_id: number;
}

export function findUserByOAuth(db: Db, provider: string, sub: string): User | undefined {
  const row = db
    .prepare<OAuthAccountRow>(
      'SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_sub = ?'
    )
    .get(provider, sub);
  if (!row) return undefined;
  return findUserById(db, row.user_id);
}

// ---- allowed_emails ----------------------------------------------------

export function inviteEmail(
  db: Db,
  email: string,
  role: Role,
  invitedBy: number | null = null,
  when: string = new Date().toISOString()
): void {
  const e = normalizeEmail(email);
  db.prepare(
    `INSERT INTO allowed_emails (email, role, invited_at, invited_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET role = excluded.role, invited_at = excluded.invited_at,
       invited_by = excluded.invited_by`
  ).run(e, role, when, invitedBy);
}

export function removeInvite(db: Db, email: string): boolean {
  const r = db.prepare('DELETE FROM allowed_emails WHERE email = ?').run(normalizeEmail(email));
  return r.changes > 0;
}

export function listInvites(db: Db): AllowedEmail[] {
  return db
    .prepare<AllowedEmail>(
      'SELECT email, role, invited_at, invited_by FROM allowed_emails ORDER BY invited_at'
    )
    .all();
}

export function isAllowed(db: Db, email: string): AllowedEmail | undefined {
  return db
    .prepare<AllowedEmail>(
      'SELECT email, role, invited_at, invited_by FROM allowed_emails WHERE email = ?'
    )
    .get(normalizeEmail(email));
}

// ---- bootstrap path: first-user-becomes-owner --------------------------

export function userCount(db: Db): number {
  return (db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM users').get() ?? { n: 0 }).n;
}

// ---- the entry point used by the auth callback -------------------------

/**
 * Resolve an OAuth identity to a user. Returns the existing user if the
 * (provider, sub) pair is known, or creates a new user when:
 *   - the email is on the allowlist (uses the allowlist's role), OR
 *   - there are zero users in the system (bootstrap: first user is `owner`).
 *
 * Throws NotInvitedError when the email is not allowed and the system has
 * existing users.
 */
export function findOrCreateOAuthUser(db: Db, identity: OAuthIdentity): User {
  const existing = findUserByOAuth(db, identity.provider, identity.sub);
  if (existing) {
    touchLastSeen(db, existing.id);
    return existing;
  }

  const email = normalizeEmail(identity.email);

  // If the email already belongs to a user from a different provider,
  // refuse to silently link. Real cross-provider linking must be
  // initiated from an authenticated session — there's no UI for that
  // yet, so anyone presenting this email via a new provider is either
  // the legitimate owner (who should log in via the original provider
  // first and link from settings) or an attacker who happens to control
  // the email at a different provider. Reject either way.
  const sameEmailUser = findUserByEmail(db, email);
  if (sameEmailUser) throw new EmailLinkedError(email);

  const create = db.transaction((): User => {
    const now = new Date().toISOString();
    const allow = isAllowed(db, email);
    const isBootstrap = userCount(db) === 0;
    if (!allow && !isBootstrap) throw new NotInvitedError(email);
    const role: Role = allow?.role ?? 'owner';
    const r = db
      .prepare(
        'INSERT INTO users (email, display_name, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(email, identity.displayName ?? null, role, now, now);
    const created = findUserById(db, r.lastInsertRowid);
    /* c8 ignore next -- defensive: row we just inserted must exist */
    if (!created) throw new Error('users insert returned no row');
    db.prepare(
      'INSERT INTO oauth_accounts (provider, provider_sub, user_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(identity.provider, identity.sub, created.id, now);
    return created;
  });

  return create();
}
