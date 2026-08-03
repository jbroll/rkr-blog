// sqliteImageFetcher: resolve a WP <img src> to a file in the backup's
// uploads tree, preferring the attachment id when the markup carries one.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { open } from '../../src/lib/db.ts';
import { resolveAttachmentPath, sqliteImageFetcher } from '../../src/lib/wp-sqlite-images.ts';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-wp-img-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uploads = path.join(root, 'uploads');
  fs.mkdirSync(path.join(uploads, '2026', '05'), { recursive: true });
  fs.writeFileSync(path.join(uploads, '2026', '05', 'photo.jpeg'), 'ORIGINAL');
  fs.writeFileSync(path.join(uploads, '2026', '05', 'photo-768x1024.jpeg'), 'RESIZED');
  fs.writeFileSync(path.join(root, 'outside.jpeg'), 'ESCAPED');

  const db = open(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE wp_postmeta (post_id INTEGER, meta_key TEXT, meta_value TEXT)');
  db.prepare('INSERT INTO wp_postmeta VALUES (?,?,?)').run(
    2365,
    '_wp_attached_file',
    '2026/05/photo.jpeg'
  );
  db.prepare('INSERT INTO wp_postmeta VALUES (?,?,?)').run(
    99,
    '_wp_attached_file',
    '../../outside.jpeg'
  );
  return { db, uploads };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString();
}

test('resolves via the wp-image-<id> fragment to the full-size original', async (t) => {
  const { db, uploads } = fixture(t);
  const fetchImage = sqliteImageFetcher(db, uploads);
  const stream = await fetchImage(
    'https://wp.example/wp-content/uploads/2026/05/photo-768x1024.jpeg#wp-image-2365'
  );
  assert.equal(await readAll(stream), 'ORIGINAL');
});

test('falls back to the URL path and strips the size suffix', async (t) => {
  const { db, uploads } = fixture(t);
  const fetchImage = sqliteImageFetcher(db, uploads);
  const stream = await fetchImage(
    'https://wp.example/wp-content/uploads/2026/05/photo-768x1024.jpeg'
  );
  assert.equal(await readAll(stream), 'ORIGINAL');
});

test('uses the URL path verbatim when no stripped original exists', async (t) => {
  const { db, uploads } = fixture(t);
  fs.rmSync(path.join(uploads, '2026', '05', 'photo.jpeg'));
  const fetchImage = sqliteImageFetcher(db, uploads);
  const stream = await fetchImage(
    'https://wp.example/wp-content/uploads/2026/05/photo-768x1024.jpeg'
  );
  assert.equal(await readAll(stream), 'RESIZED');
});

test('rejects an attachment path that escapes the uploads root', (t) => {
  const { db, uploads } = fixture(t);
  assert.equal(resolveAttachmentPath(db, uploads, 'https://wp.example/x.jpeg#wp-image-99'), null);
});

test('throws a useful error when nothing resolves', async (t) => {
  const { db, uploads } = fixture(t);
  const fetchImage = sqliteImageFetcher(db, uploads);
  await assert.rejects(
    () => fetchImage('https://wp.example/wp-content/uploads/2026/05/absent.jpeg'),
    /not in the backup/
  );
});
