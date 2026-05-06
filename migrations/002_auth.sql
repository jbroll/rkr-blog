-- Auth refactor: replace single-password with Google social login
-- (spec §17). Drops the old auth/sessions/oauth_tokens and rebuilds
-- everything to be per-user.

DROP TABLE IF EXISTS auth;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS oauth_tokens;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner','editor')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE oauth_accounts (
  provider TEXT NOT NULL,
  provider_sub TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_sub)
);

CREATE INDEX oauth_accounts_user ON oauth_accounts(user_id);

CREATE TABLE allowed_emails (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner','editor')),
  invited_at TEXT NOT NULL,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE oauth_tokens (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  access_token BLOB NOT NULL,
  refresh_token BLOB,
  expires_at TEXT NOT NULL,
  scope TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);
