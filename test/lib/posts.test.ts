import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import {
  imageIdsForPost,
  listPosts,
  listSidecarIds,
  scanPostForImageIds
} from '../../src/lib/posts.ts';

function freshSiteRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-posts-'));
  for (const sub of ['sidecars', 'content/posts']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSidecarStub(root: string, id: string): void {
  fs.writeFileSync(
    path.join(root, 'sidecars', `${id}.json`),
    JSON.stringify({ original: id, version: 1 })
  );
}

const FULL_A = 'a'.repeat(64);
const FULL_B = `b${'a'.repeat(63)}`;
const FULL_C = `c${'a'.repeat(63)}`;

test('listSidecarIds returns only well-formed 64-hex ids', (t) => {
  const root = freshSiteRoot(t);
  writeSidecarStub(root, FULL_A);
  fs.writeFileSync(path.join(root, 'sidecars', 'NOTHEX.json'), '{}');
  fs.writeFileSync(path.join(root, 'sidecars', 'README.txt'), '');

  const ids = listSidecarIds(root);
  assert.deepEqual(ids, [FULL_A]);
});

test('listSidecarIds returns an empty list when sidecars/ is absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-no-sidecars-'));
  try {
    assert.deepEqual(listSidecarIds(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanPostForImageIds resolves full ids and unique short prefixes', () => {
  const known = new Set([FULL_A, FULL_B, FULL_C]);
  const body =
    `Para with full id ${FULL_A}.\n\n` +
    `Para with prefix b${'a'.repeat(5)} (unique).\n\n` +
    'Para with no ids.\n';
  const refs = scanPostForImageIds(body, known);
  assert.ok(refs.has(FULL_A));
  assert.ok(refs.has(FULL_B));
});

test('scanPostForImageIds silently ignores ambiguous short prefixes', () => {
  const known = new Set([FULL_A, `aa${'b'.repeat(62)}`]);
  // `aa` is a 2-char (too short). `aab` is 3 chars (also below 6 threshold).
  // Use 6 chars that match BOTH ids.
  const body = `prefix aaaaaa here\n`;
  const refs = scanPostForImageIds(body, known);
  // aaaaaa is a unique prefix only of FULL_A (since FULL_B starts aab...) so
  // should resolve. To force ambiguity:
  const known2 = new Set(['a'.repeat(64), `${'a'.repeat(6)}${'c'.repeat(58)}`]);
  const refs2 = scanPostForImageIds(`see aaaaaa around\n`, known2);
  // Both ids start with `aaaaaa` — the prefix matches both, so neither is
  // resolved.
  assert.equal(refs2.size, 0);
  // Sanity-check the original case still works.
  assert.ok(refs.has(FULL_A));
});

test('listPosts: with frontmatter slug, slug wins over filename', (t) => {
  const root = freshSiteRoot(t);
  fs.writeFileSync(
    path.join(root, 'content', 'posts', '2026-05-06-from-file.md'),
    `---\nslug: explicit-slug\ntitle: T\n---\n\nbody\n`
  );
  const posts = listPosts(root);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.slug, 'explicit-slug');
});

test('listPosts: without frontmatter, slug derives from filename minus date prefix', (t) => {
  const root = freshSiteRoot(t);
  fs.writeFileSync(
    path.join(root, 'content', 'posts', '2026-05-06-no-frontmatter.md'),
    `Just body, no frontmatter.\n`
  );
  const posts = listPosts(root);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.slug, 'no-frontmatter');
});

test('listPosts returns empty when content/posts is absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-no-posts-'));
  try {
    assert.deepEqual(listPosts(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('imageIdsForPost returns null for unknown slug', (t) => {
  const root = freshSiteRoot(t);
  assert.equal(imageIdsForPost(root, 'nope'), null);
});

test('imageIdsForPost returns the referenced ids for a known post', (t) => {
  const root = freshSiteRoot(t);
  writeSidecarStub(root, FULL_A);
  fs.writeFileSync(
    path.join(root, 'content', 'posts', 'p.md'),
    `---\nslug: p\ntitle: P\n---\n\n::image{#${FULL_A}}\n`
  );
  const ids = imageIdsForPost(root, 'p');
  assert.ok(ids?.has(FULL_A));
});
