-- Reader comments. One table; one level of threading (parent_id must
-- reference a top-level comment, enforced in src/lib/comments.ts — SQLite
-- can't express "parent's parent_id IS NULL" as a CHECK). Imported WP
-- comments insert directly as 'published' with source='wp-import' and a
-- UNIQUE wp_comment_id for idempotent re-import.

CREATE TABLE comments (
  id             INTEGER PRIMARY KEY,
  post_id        INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  parent_id      INTEGER NULL REFERENCES comments(id) ON DELETE CASCADE,
  wp_comment_id  INTEGER NULL UNIQUE,
  author_name    TEXT NOT NULL,
  author_email   TEXT NOT NULL,
  author_url     TEXT NULL,
  body           TEXT NOT NULL,
  status         TEXT NOT NULL
                   CHECK (status IN ('pending','published','queued','rejected')),
  source         TEXT NOT NULL DEFAULT 'web'
                   CHECK (source IN ('web','wp-import')),
  spam_score     REAL NULL,
  spam_reason    TEXT NULL,
  ip             TEXT NULL,
  created_at     TEXT NOT NULL,
  classified_at  TEXT NULL
);

CREATE INDEX comments_post   ON comments(post_id, status, created_at);
CREATE INDEX comments_status ON comments(status, created_at);
CREATE INDEX comments_parent ON comments(parent_id);
