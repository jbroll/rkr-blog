// Unit tests for src/admin/opfs-schema.ts — ensureSchema() behaviour.
//
// Reuses the shared in-memory OPFS mock from opfs-mock.ts.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { installMockOpfs } from './opfs-mock.ts';

const { getMockRoot, resetMockOpfs } = installMockOpfs();

// ---- helpers to plant outbox entries directly into the mock --------

async function plantOutboxEntry(name: string): Promise<void> {
  const mockRoot = getMockRoot();
  const outbox = await mockRoot.getDirectoryHandle('outbox', { create: true });
  const h = await outbox.getFileHandle(name, { create: true });
  const w = await h.createWritable();
  await w.write(`{"seq":1,"op":"savePost"}`);
  await w.close();
}

// ---- imports -------------------------------------------------------

const { ensureSchema, readRoot } = await import('../../src/admin/opfs-schema.ts');

beforeEach(() => {
  resetMockOpfs();
});

// ---- tests ---------------------------------------------------------

test('ensureSchema: fresh OPFS with empty outbox → status=fresh, nextSeq=0', async () => {
  const result = await ensureSchema();
  assert.equal(result.status, 'fresh');
  const root = await readRoot();
  assert.ok(root !== null, 'root must be written');
  assert.equal(root.nextSeq, 0, 'empty outbox: nextSeq must stay 0');
});

test('ensureSchema: fresh OPFS with outbox entries → status=fresh, nextSeq above max seq', async () => {
  // Plant outbox entries with seqs 1, 2, 5 (non-contiguous, matching
  // the filename convention <seq>.<op>.json).
  await plantOutboxEntry('1.savePost.json');
  await plantOutboxEntry('2.upload.json');
  await plantOutboxEntry('5.savePost.json');

  const result = await ensureSchema();
  assert.equal(result.status, 'fresh');

  const root = await readRoot();
  assert.ok(root !== null, 'root must be written');
  assert.ok(
    (root.nextSeq ?? 0) >= 6,
    `nextSeq must be > 5 (highest outbox seq) but got ${root.nextSeq}`
  );
});

test('ensureSchema: existing valid root → status=current, no overwrite', async () => {
  // Run once to create the root.
  await ensureSchema();
  const firstRoot = await readRoot();
  assert.ok(firstRoot !== null);

  // Second call should see it as current.
  const result = await ensureSchema();
  assert.equal(result.status, 'current');

  // deviceId must be unchanged (root was not regenerated).
  const secondRoot = await readRoot();
  assert.equal(secondRoot?.deviceId, firstRoot.deviceId);
});

test('ensureSchema: corrupt _root.json (quarantined → null) with outbox entries → nextSeq above max', async () => {
  // Plant a corrupt _root.json that readJson will quarantine and return null.
  const mockRoot = getMockRoot();
  const meta = await mockRoot.getDirectoryHandle('meta', { create: true });
  const h = await meta.getFileHandle('_root.json', { create: true });
  const w = await h.createWritable();
  await w.write('{ not valid json at all');
  await w.close();

  // Plant outbox entries.
  await plantOutboxEntry('3.savePost.json');
  await plantOutboxEntry('7.upload.json');

  const result = await ensureSchema();
  assert.equal(result.status, 'fresh', 'quarantined root treated as missing → fresh');

  const root = await readRoot();
  assert.ok(root !== null);
  assert.ok(
    (root.nextSeq ?? 0) >= 8,
    `nextSeq must be > 7 (highest outbox seq) but got ${root.nextSeq}`
  );
});
