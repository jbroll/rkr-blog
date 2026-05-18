import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { atomicWriteWithRoot, removeFileWithRoot } from '../../src/admin/opfs-worker.ts';
import { installMockOpfs } from './opfs-mock.ts';

const { getMockRoot, resetMockOpfs, setFault, setNoSyncHandle } = installMockOpfs();

describe('atomicWriteWithRoot', () => {
  beforeEach(() => resetMockOpfs());

  it('writes a string round-trip', async () => {
    const root = getMockRoot() as unknown as FileSystemDirectoryHandle;
    await atomicWriteWithRoot(root, 'a/b.txt', 'hello');
    const dir = getMockRoot().entries.get('a');
    assert.ok(dir?.kind === 'directory');
    const fh = dir.entries.get('b.txt');
    assert.ok(fh?.kind === 'file');
    assert.equal(await fh.file.text(), 'hello');
  });

  it('writes an ArrayBuffer round-trip', async () => {
    const root = getMockRoot() as unknown as FileSystemDirectoryHandle;
    const data = new TextEncoder().encode('world').buffer as ArrayBuffer;
    await atomicWriteWithRoot(root, 'buf.bin', data);
    const fh = getMockRoot().entries.get('buf.bin');
    assert.ok(fh?.kind === 'file');
    assert.equal(await fh.file.text(), 'world');
  });

  it('throws TypeError when createSyncAccessHandle is unavailable', async () => {
    setNoSyncHandle(() => true);
    const root = getMockRoot() as unknown as FileSystemDirectoryHandle;
    await assert.rejects(() => atomicWriteWithRoot(root, 'x.txt', 'y'), TypeError);
  });

  it('propagates transient fault as non-TypeError', async () => {
    setFault(() => true);
    const root = getMockRoot() as unknown as FileSystemDirectoryHandle;
    let threw: unknown;
    try {
      await atomicWriteWithRoot(root, 'x.txt', 'y');
    } catch (e) {
      threw = e;
    }
    assert.ok(threw instanceof Error);
    assert.ok(!(threw instanceof TypeError));
  });

  it('cleans up temp file on failure', async () => {
    setFault(() => true);
    const root = getMockRoot() as unknown as FileSystemDirectoryHandle;
    try {
      await atomicWriteWithRoot(root, 'x.txt', 'y');
    } catch {
      /* expected */
    }
    for (const name of getMockRoot().entries.keys()) {
      assert.ok(!name.includes('.tmp'), `unexpected temp: ${name}`);
    }
  });
});

describe('removeFileWithRoot', () => {
  beforeEach(() => resetMockOpfs());

  it('removes an existing file', async () => {
    const root = getMockRoot() as unknown as FileSystemDirectoryHandle;
    await atomicWriteWithRoot(root, 'del.txt', 'x');
    await removeFileWithRoot(root, 'del.txt');
    assert.equal(getMockRoot().entries.get('del.txt'), undefined);
  });

  it('is silent when file does not exist', async () => {
    const root = getMockRoot() as unknown as FileSystemDirectoryHandle;
    await removeFileWithRoot(root, 'nonexistent.txt');
  });
});
