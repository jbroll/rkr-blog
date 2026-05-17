-- Full-text search index over posts. Standalone FTS5 table (not
-- external-content): body text is not a column on `posts`. Populated
-- by doReindex (src/lib/post-index.ts) in the same pass that upserts
-- `posts`; joined back to `posts` on slug for status/date scoping.
-- slug is stored UNINDEXED purely for that join.
CREATE VIRTUAL TABLE posts_fts USING fts5(
  slug UNINDEXED,
  title,
  tags,
  body,
  tokenize = 'porter unicode61'
);
