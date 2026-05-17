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

// ---- minimal in-memory OPFS mock -----------------------------------

type FaultFn = ((path: string) => boolean) | null;

// Each handle/file/writable below models exactly the slice of the
// File System Access API that opfs.ts touches. The interfaces keep
// the structural shape the wrapper feature-detects against (notably
// the optional .move on a file handle) while staying fully typed —
// no implicit any, no never, no this-as-null.
//
// NB: node --experimental-strip-types runs in strip-only mode, so no
// TS parameter properties / runtime-emitting syntax — fields are
// declared explicitly and assigned in the constructor body.

interface HandleOpts {
  create?: boolean;
}

interface MockFile {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  path: string;
}

interface MockWritable {
  write(data: string | Blob): Promise<void>;
  close(): Promise<void>;
}

interface MockFileHandle {
  kind: 'file';
  name: string;
  createWritable(): Promise<MockWritable>;
  getFile(): Promise<MockFile>;
  // opfs.ts feature-detects tmpHandle.move; the mock always provides
  // it so the atomic-rename branch (not the copy fallback) is the one
  // unit-tested.
  move(parent: MockDirHandle, newName: string): Promise<void>;
}

interface MockDirHandle {
  kind: 'directory';
  name: string;
  path: string;
  entries: Map<string, MockFileHandle | MockDirHandle>;
  getDirectoryHandle(name: string, opts?: HandleOpts): Promise<MockDirHandle>;
  getFileHandle(name: string, opts?: HandleOpts): Promise<MockFileHandle>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterableIterator<string>;
}

class MockFileImpl implements MockFile {
  contents = '';
  blob: Blob | null = null;
  path: string;
  constructor(path: string) {
    this.path = path;
  }
  async text(): Promise<string> {
    return this.blob ? this.blob.text() : this.contents;
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.blob) return this.blob.arrayBuffer();
    return new TextEncoder().encode(this.contents).buffer;
  }
}

class MockWritableImpl implements MockWritable {
  #file: MockFileImpl;
  #buf: Array<string | Blob> = [];
  constructor(file: MockFileImpl) {
    this.#file = file;
    // Real createWritable() truncates the target immediately.
    this.#file.contents = '';
    this.#file.blob = null;
  }
  async write(data: string | Blob): Promise<void> {
    if (mockFault?.(this.#file.path)) {
      throw new Error(`injected write fault: ${this.#file.path}`);
    }
    this.#buf.push(data);
  }
  async close(): Promise<void> {
    const last = this.#buf[this.#buf.length - 1];
    if (last instanceof Blob) {
      this.#file.blob = last;
      this.#file.contents = '';
    } else {
      this.#file.contents = this.#buf.join('');
      this.#file.blob = null;
    }
  }
}

class MockFileHandleImpl implements MockFileHandle {
  kind = 'file' as const;
  name: string;
  file: MockFileImpl;
  owner: MockDirHandleImpl | null = null;
  ownerName = '';
  constructor(name: string, file: MockFileImpl) {
    this.name = name;
    this.file = file;
  }
  async createWritable(): Promise<MockWritable> {
    return new MockWritableImpl(this.file);
  }
  async getFile(): Promise<MockFile> {
    return this.file;
  }
  // The wrapper feature-detects tmpHandle.move; provide the atomic
  // swap so the move() branch (not the fallback) is exercised.
  async move(parent: MockDirHandle, newName: string): Promise<void> {
    const dst = parent as MockDirHandleImpl;
    if (this.owner) this.owner.entries.delete(this.ownerName);
    dst.entries.set(newName, this);
    this.name = newName;
    this.file.path = `${dst.path}/${newName}`;
    this.owner = dst;
    this.ownerName = newName;
  }
}

class MockDirHandleImpl implements MockDirHandle {
  kind = 'directory' as const;
  entries = new Map<string, MockFileHandleImpl | MockDirHandleImpl>();
  name: string;
  path: string;
  constructor(name: string, path: string) {
    this.name = name;
    this.path = path;
  }
  async getDirectoryHandle(name: string, opts?: HandleOpts): Promise<MockDirHandle> {
    const existing = this.entries.get(name);
    if (existing && existing.kind === 'directory') return existing;
    if (!opts?.create) throw new Error(`NotFound: dir ${name}`);
    const d = new MockDirHandleImpl(name, `${this.path}/${name}`);
    this.entries.set(name, d);
    return d;
  }
  async getFileHandle(name: string, opts?: HandleOpts): Promise<MockFileHandle> {
    const existing = this.entries.get(name);
    if (existing && existing.kind === 'file') return existing;
    if (!opts?.create) throw new Error(`NotFound: file ${name}`);
    const h = new MockFileHandleImpl(name, new MockFileImpl(`${this.path}/${name}`));
    h.owner = this;
    h.ownerName = name;
    this.entries.set(name, h);
    return h;
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.entries.has(name)) throw new Error(`NotFound: ${name}`);
    this.entries.delete(name);
  }
  async *keys(): AsyncIterableIterator<string> {
    for (const k of this.entries.keys()) yield k;
  }
}

let mockRoot: MockDirHandleImpl = new MockDirHandleImpl('', '');
let mockFault: FaultFn = null;

function resetMockOpfs(): void {
  mockRoot = new MockDirHandleImpl('', '');
  mockFault = null;
}

// Install the navigator.storage seam before opfs.ts is imported so
// isSupported()'s one-shot cache resolves to true. getDirectory()
// returns the *current* mockRoot each call; opfs.ts caches the first
// resolved root for the process, so resetMockOpfs swaps the tree the
// cached promise's handle still points at — instead we re-point by
// keeping the cached promise resolving to a stable proxy root.
const stableRoot = new MockDirHandleImpl('', '');

// opfs.ts caches the root promise once; expose a proxy whose handle
// methods delegate to the live mockRoot so each test starts fresh.
const mockRootProxy = new Proxy(stableRoot, {
  get(_t: MockDirHandleImpl, prop: string | symbol): unknown {
    const v = Reflect.get(mockRoot, prop) as unknown;
    return typeof v === 'function' ? v.bind(mockRoot) : v;
  }
}) as unknown as FileSystemDirectoryHandle;

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    storage: {
      getDirectory: async (): Promise<FileSystemDirectoryHandle> => mockRootProxy
    }
  }
});

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
  mockFault = (p) => p.endsWith('/meta/_root.json') || p.includes('_root.json');

  await assert.rejects(
    () => writeJson('meta/_root.json', { version: 2, posts: ['c'] }),
    /injected write fault/
  );

  // Original content must survive byte-for-byte (not truncated/empty).
  mockFault = null;
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
