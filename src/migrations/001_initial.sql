PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  path TEXT NOT NULL                  -- relative path to .md file under content/
);

CREATE INDEX posts_status_published ON posts(status, published_at DESC);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                 -- 'render' for now
  payload TEXT NOT NULL,              -- JSON: {originalId, ops, variant, output}
  state TEXT NOT NULL                 -- 'queued','running','done','failed'
    CHECK (state IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cache_key TEXT UNIQUE               -- dedupe: same derivative not enqueued twice
);

CREATE INDEX jobs_state_created ON jobs(state, created_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                -- 32 random bytes hex
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE oauth_tokens (
  provider TEXT PRIMARY KEY,          -- 'gdrive','onedrive'
  access_token BLOB NOT NULL,         -- encrypted
  refresh_token BLOB,                 -- encrypted
  expires_at TEXT NOT NULL
);

CREATE TABLE auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- single-row table
  password_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
