-- The comment form no longer collects a website and author names render
-- as plain text, so comments.author_url is unused. Drop it.
-- SQLite (node:sqlite bundles 3.50.4) supports ALTER TABLE DROP COLUMN;
-- author_url is a plain, unindexed column with no triggers/views, so the
-- drop is clean inside the migration runner's transaction.
ALTER TABLE comments DROP COLUMN author_url;
