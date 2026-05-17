// Unit tests for the OPFS wrapper (src/admin/opfs.ts). The repo had
// no OPFS unit harness (opfs.ts was only exercised via Playwright
// e2e, hence its c8 exclusion); this file introduces a minimal
// in-memory mock of the slice of the File System Access API the
// wrapper touches — directory/file handles, createWritable (which
// truncates on open, like the real API), getFile, removeEntry, keys,
// and the atomic move(). A fault seam lets a test make a specific
// write() throw so the atomicity contract can be pinned.
//
// navigator.storage.getDirectory is module-cached inside opfs.ts, so
// the mock root is swapped via a closure (resetMockOpfs) rather than
// re-stubbing navigator between tests.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { installMockOpfs } from './opfs-mock.ts';

const { getMockRoot, resetMockOpfs, setFault } = installMockOpfs();

const { readJson, writeJson, writeBlob, listDir } = await import('../../src/admin/opfs.ts');
const { gcAtomicWriteTemps } = await import('../../src/admin/outbox.ts');

beforeEach(() => {
  resetMockOpfs();
});

// ---- atomicity ------------------------------------------------------

test('writeJson: a failed second write leaves the original intact', async () => {
  await writeJson('meta/_root.json', { version: 1, posts: ['a', 'b'] });
  const first = await readJson<{ version: number; posts: string[] }>('meta/_root.json');
  assert.deepEqual(first, { version: 1, posts: ['a', 'b'] });

  // Make the *next* write() on _root.json throw (a crash mid-write).
  setFault((p) => p.endsWith('/meta/_root.json') || p.includes('_root.json'));

  await assert.rejects(
    () => writeJson('meta/_root.json', { version: 2, posts: ['c'] }),
    /injected write fault/
  );

  // Original content must survive byte-for-byte (not truncated/empty).
  setFault(null);
  const after = await readJson<{ version: number; posts: string[] }>('meta/_root.json');
  assert.deepEqual(
    after,
    { version: 1, posts: ['a', 'b'] },
    'original _root.json must be fully intact after a failed write'
  );

  // No temp residue left behind in meta/.
  const names = await listDir('meta');
  assert.deepEqual(names, ['_root.json'], 'failed write must not leak a temp file');
});

// ---- corrupt-JSON quarantine ---------------------------------------

test('readJson: invalid JSON returns null and quarantines the file', async () => {
  // Plant a crash-truncated file directly through the mock.
  const mockRoot = getMockRoot();
  const meta = await mockRoot.getDirectoryHandle('meta', { create: true });
  const h = await meta.getFileHandle('_root.json', { create: true });
  const w = await h.createWritable();
  await w.write('{ this is not json');
  await w.close();

  const result = await readJson('meta/_root.json');
  assert.equal(result, null, 'unparseable JSON must read as null, not throw');

  const names = await listDir('meta');
  assert.ok(
    !names.includes('_root.json'),
    'corrupt file must be removed so listDir/outbox.list() do not see it'
  );
});

// ---- atomic-write temp sweep ---------------------------------------

test('gcAtomicWriteTemps: removes .tmp- stragglers, keeps live files', async () => {
  // Seed an OPFS dir the wrapper writes into ('drafts') with a leaked
  // atomic-write temp alongside a normal, live file.
  const mockRoot = getMockRoot();
  const drafts = await mockRoot.getDirectoryHandle('drafts', { create: true });
  const straggler = await drafts.getFileHandle('._root.json.tmp-abc', {
    create: true
  });
  const sw = await straggler.createWritable();
  await sw.write('{"half":');
  await sw.close();
  await writeJson('drafts/keep.json', { live: true });

  assert.deepEqual(
    (await listDir('drafts')).sort(),
    ['._root.json.tmp-abc', 'keep.json'],
    'precondition: straggler + live file both present'
  );

  const removed = await gcAtomicWriteTemps();

  assert.equal(removed, 1, 'exactly the one .tmp- straggler swept');
  assert.deepEqual(
    await listDir('drafts'),
    ['keep.json'],
    '.tmp- straggler gone, live file untouched'
  );
  assert.deepEqual(
    await readJson('drafts/keep.json'),
    { live: true },
    'live file content intact after sweep'
  );
});

test('writeBlob then readJson(absent) and round-trip still work', async () => {
  await writeBlob('blobs/x.bin', new Blob([new Uint8Array([1, 2, 3])]));
  const names = await listDir('blobs');
  assert.deepEqual(names, ['x.bin']);
  assert.equal(await readJson('meta/missing.json'), null);
});
