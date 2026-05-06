// Encrypted CRUD on `oauth_tokens` (per-user picker integration tokens).
// access_token + refresh_token are stored as BLOB ciphertext using
// lib/secrets.ts (AES-256-GCM, key from $SITE_ROOT/data/secret.key).

import type { Db } from './db.ts';
import { decrypt, encrypt } from './secrets.ts';

export interface StoredOAuthToken {
  user_id: number;
  provider: string; // 'gdrive' | 'onedrive' (future)
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
  scope: string | null;
  created_at: string;
  updated_at: string;
}

interface RawRow {
  user_id: number;
  provider: string;
  access_token: Buffer;
  refresh_token: Buffer | null;
  expires_at: string;
  scope: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertTokenArgs {
  userId: number;
  provider: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: string;
  scope?: string | null;
}

/**
 * Insert or update a token row. The `(user_id, provider)` PK means each
 * user has exactly one row per provider — re-connecting overwrites.
 */
export function upsertToken(db: Db, key: Buffer, args: UpsertTokenArgs): void {
  const now = new Date().toISOString();
  const accessCt = encrypt(args.accessToken, key);
  const refreshCt = args.refreshToken ? encrypt(args.refreshToken, key) : null;

  db.prepare(
    `INSERT INTO oauth_tokens
       (user_id, provider, access_token, refresh_token, expires_at, scope, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET
       access_token  = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
       expires_at    = excluded.expires_at,
       scope         = COALESCE(excluded.scope, oauth_tokens.scope),
       updated_at    = excluded.updated_at`
  ).run(
    args.userId,
    args.provider,
    accessCt,
    refreshCt,
    args.expiresAt,
    args.scope ?? null,
    now,
    now
  );
}

/** Read and decrypt a token row. Returns null when absent. */
export function readToken(
  db: Db,
  key: Buffer,
  userId: number,
  provider: string
): StoredOAuthToken | null {
  const row = db
    .prepare<RawRow>(
      `SELECT user_id, provider, access_token, refresh_token, expires_at, scope,
              created_at, updated_at
         FROM oauth_tokens
        WHERE user_id = ? AND provider = ?`
    )
    .get(userId, provider);
  if (!row) return null;
  return {
    user_id: row.user_id,
    provider: row.provider,
    access_token: decrypt(row.access_token, key),
    refresh_token: row.refresh_token ? decrypt(row.refresh_token, key) : null,
    expires_at: row.expires_at,
    scope: row.scope,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/** Delete the row. Returns true if a row was removed. */
export function deleteToken(db: Db, userId: number, provider: string): boolean {
  return (
    db.prepare('DELETE FROM oauth_tokens WHERE user_id = ? AND provider = ?').run(userId, provider)
      .changes > 0
  );
}

/** True iff the access token's `expires_at` is in the past (with optional skew). */
export function isExpired(token: StoredOAuthToken, skewMs: number = 30_000): boolean {
  return Date.parse(token.expires_at) - skewMs <= Date.now();
}
