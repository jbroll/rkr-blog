import crypto from 'node:crypto';
import fs from 'node:fs';

export const ARCHIVE_VERSION = '1';

export const ARCHIVE_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files (path TEXT PRIMARY KEY, data BLOB NOT NULL);
CREATE TABLE comments (
  export_id INTEGER NOT NULL, post_slug TEXT NOT NULL, parent_export_id INTEGER NULL,
  wp_comment_id INTEGER NULL, author_name TEXT NOT NULL, author_email TEXT NOT NULL,
  body TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
  spam_score REAL NULL, spam_reason TEXT NULL, ip TEXT NULL,
  created_at TEXT NOT NULL, classified_at TEXT NULL
);
CREATE TABLE users (
  email TEXT PRIMARY KEY, display_name TEXT, role TEXT NOT NULL,
  created_at TEXT NOT NULL, last_seen_at TEXT
);
CREATE TABLE allowed_emails (email TEXT PRIMARY KEY, role TEXT NOT NULL, invited_at TEXT NOT NULL);
`.trim();

export function writeBlob(target: string, data: Uint8Array): void {
  const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
    /* c8 ignore start — error cleanup rarely exercised in unit tests */
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  /* c8 ignore stop */
}
