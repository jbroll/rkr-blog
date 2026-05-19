// Shared in-memory OPFS mock for unit tests.
//
// Models the slice of the File System Access API that src/admin/opfs.ts
// touches: directory/file handles, createWritable (truncates on open,
// like the real API), getFile, removeEntry, keys, atomic move(), and
// createSyncAccessHandle (used by opfs-worker.ts).
// A fault seam (mockFault) lets tests make a specific write() throw.
// setNoSyncHandle() simulates createSyncAccessHandle being unavailable
// (TypeError — iOS 16 scenario).
//
// opfs.ts caches the OPFS root promise once. This module exports a
// stable proxy whose methods always delegate to the current mockRoot,
// so each test can call resetMockOpfs() without defeating the cache.
//
// installMockOpfs() also installs a global Worker mock that routes
// postMessage calls directly to atomicWriteWithRoot/removeFileWithRoot,
// so opfs.ts's write path works in Node without a real Worker.
//
// NB: node --experimental-strip-types runs in strip-only mode — no
// TS parameter properties or other runtime-emitting syntax.

export interface HandleOpts {
  create?: boolean;
}

export interface MockFile {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  path: string;
}

export interface MockWritable {
  write(data: string | Blob | ArrayBuffer): Promise<void>;
  close(): Promise<void>;
}

export interface MockSyncHandle {
  write(data: BufferSource, opts?: { at?: number }): number;
  flush(): void;
  close(): void;
}

export interface MockFileHandle {
  kind: 'file';
  name: string;
  createWritable(): Promise<MockWritable>;
  createSyncAccessHandle(): Promise<MockSyncHandle>;
  getFile(): Promise<MockFile>;
  move(parent: MockDirHandle, newName: string): Promise<void>;
}

export interface MockDirHandle {
  kind: 'directory';
  name: string;
  path: string;
  entries: Map<string, MockFileHandle | MockDirHandle>;
  getDirectoryHandle(name: string, opts?: HandleOpts): Promise<MockDirHandle>;
  getFileHandle(name: string, opts?: HandleOpts): Promise<MockFileHandle>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterableIterator<string>;
}

export type FaultFn = ((path: string) => boolean) | null;
export type NoSyncHandleFn = (() => boolean) | null;

export class MockFileImpl implements MockFile {
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

/** Opt-in async gate: returns a Promise the next matching write()
 * awaits (default null = no gating). Separate seam from `fault` so a
 * test can pause a specific write (e.g. append's JSON commit) and
 * interleave another op deterministically without injecting an error. */
export type GateFn = ((path: string) => Promise<void> | null) | null;

export class MockWritableImpl implements MockWritable {
  #file: MockFileImpl;
  #buf: Array<string | Blob | ArrayBuffer> = [];
  #fault: () => FaultFn;
  #gate: () => GateFn;
  constructor(file: MockFileImpl, getFault: () => FaultFn, getGate: () => GateFn = () => null) {
    this.#file = file;
    this.#fault = getFault;
    this.#gate = getGate;
    this.#file.contents = '';
    this.#file.blob = null;
  }
  async write(data: string | Blob | ArrayBuffer): Promise<void> {
    if (this.#fault()?.(this.#file.path)) {
      throw new Error(`injected write fault: ${this.#file.path}`);
    }
    const wait = this.#gate()?.(this.#file.path);
    if (wait) await wait;
    this.#buf.push(data);
  }
  async close(): Promise<void> {
    const last = this.#buf[this.#buf.length - 1];
    if (last instanceof Blob) {
      this.#file.blob = last;
      this.#file.contents = '';
    } else if (last instanceof ArrayBuffer) {
      this.#file.contents = new TextDecoder().decode(new Uint8Array(last));
      this.#file.blob = null;
    } else {
      this.#file.contents = this.#buf.join('');
      this.#file.blob = null;
    }
  }
}

class MockSyncHandleImpl implements MockSyncHandle {
  #file: MockFileImpl;
  #buf = new Uint8Array(0);
  #size = 0;
  constructor(file: MockFileImpl) {
    this.#file = file;
    this.#file.contents = '';
    this.#file.blob = null;
  }
  write(data: BufferSource, opts?: { at?: number }): number {
    let src: Uint8Array;
    if (data instanceof ArrayBuffer) {
      src = new Uint8Array(data);
    } else {
      const view = data as ArrayBufferView;
      src = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    const at = opts?.at ?? this.#size;
    const needed = at + src.byteLength;
    if (needed > this.#buf.byteLength) {
      const next = new Uint8Array(needed);
      next.set(this.#buf.subarray(0, this.#size));
      this.#buf = next;
    }
    this.#buf.set(src, at);
    this.#size = Math.max(this.#size, needed);
    return src.byteLength;
  }
  flush(): void {}
  close(): void {
    this.#file.contents = new TextDecoder().decode(this.#buf.subarray(0, this.#size));
    this.#file.blob = null;
  }
}

export class MockFileHandleImpl implements MockFileHandle {
  kind = 'file' as const;
  name: string;
  file: MockFileImpl;
  owner: MockDirHandleImpl | null = null;
  ownerName = '';
  #getFault: () => FaultFn;
  #getGate: () => GateFn;
  #getNoSyncHandle: () => NoSyncHandleFn;
  constructor(
    name: string,
    file: MockFileImpl,
    getFault: () => FaultFn,
    getGate: () => GateFn = () => null,
    getNoSyncHandle: () => NoSyncHandleFn = () => null
  ) {
    this.name = name;
    this.file = file;
    this.#getFault = getFault;
    this.#getGate = getGate;
    this.#getNoSyncHandle = getNoSyncHandle;
  }
  async createWritable(): Promise<MockWritable> {
    return new MockWritableImpl(this.file, this.#getFault, this.#getGate);
  }
  async createSyncAccessHandle(): Promise<MockSyncHandle> {
    if (this.#getNoSyncHandle()?.()) {
      throw new TypeError('createSyncAccessHandle: not available');
    }
    if (this.#getFault()?.(this.file.path)) {
      throw new Error(`injected write fault: ${this.file.path}`);
    }
    const wait = this.#getGate()?.(this.file.path);
    if (wait) await wait;
    return new MockSyncHandleImpl(this.file);
  }
  async getFile(): Promise<MockFile> {
    return this.file;
  }
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

export class MockDirHandleImpl implements MockDirHandle {
  kind = 'directory' as const;
  entries = new Map<string, MockFileHandleImpl | MockDirHandleImpl>();
  name: string;
  path: string;
  #getFault: () => FaultFn;
  #getGate: () => GateFn;
  #getNoSyncHandle: () => NoSyncHandleFn;
  constructor(
    name: string,
    path: string,
    getFault: () => FaultFn = () => null,
    getGate: () => GateFn = () => null,
    getNoSyncHandle: () => NoSyncHandleFn = () => null
  ) {
    this.name = name;
    this.path = path;
    this.#getFault = getFault;
    this.#getGate = getGate;
    this.#getNoSyncHandle = getNoSyncHandle;
  }
  async getDirectoryHandle(name: string, opts?: HandleOpts): Promise<MockDirHandle> {
    const existing = this.entries.get(name);
    if (existing && existing.kind === 'directory') return existing;
    if (!opts?.create) throw new Error(`NotFound: dir ${name}`);
    const d = new MockDirHandleImpl(
      name,
      `${this.path}/${name}`,
      this.#getFault,
      this.#getGate,
      this.#getNoSyncHandle
    );
    this.entries.set(name, d);
    return d;
  }
  async getFileHandle(name: string, opts?: HandleOpts): Promise<MockFileHandle> {
    const existing = this.entries.get(name);
    if (existing && existing.kind === 'file') return existing;
    if (!opts?.create) throw new Error(`NotFound: file ${name}`);
    const h = new MockFileHandleImpl(
      name,
      new MockFileImpl(`${this.path}/${name}`),
      this.#getFault,
      this.#getGate,
      this.#getNoSyncHandle
    );
    h.owner = this;
    h.ownerName = name;
    this.entries.set(name, h);
    return h;
  }
  async removeEntry(name: string): Promise<void> {
    if (!this.entries.has(name)) throw new Error(`NotFound: ${name}`);
    const path = `${this.path}/${name}`;
    const wait = this.#getGate()?.(path);
    if (wait) await wait;
    this.entries.delete(name);
  }
  async *keys(): AsyncIterableIterator<string> {
    for (const k of this.entries.keys()) yield k;
  }
}

/** Minimal Web Locks (navigator.locks) mock: serializes callbacks
 * per lock name (exclusive mode only — the prod code never uses
 * 'shared'), and honours `{ ifAvailable: true }` by invoking the
 * callback with `null` when the lock is held. Faithful enough to
 * exercise the rkr-outbox-append serialization the sweeps rely on
 * and the rkr-sync-leader ifAvailable guard tryDrain uses. */
class MockLockManager {
  #chains = new Map<string, Promise<unknown>>();

  request(name: string, a: unknown, b?: unknown): Promise<unknown> {
    const opts = (typeof a === 'object' && a !== null ? a : {}) as {
      ifAvailable?: boolean;
    };
    const cb = (typeof a === 'function' ? a : b) as (lock: unknown) => unknown | Promise<unknown>;
    const prev = this.#chains.get(name);
    if (opts.ifAvailable && prev) {
      // Lock is held — the spec calls back with null and does not queue.
      return Promise.resolve().then(() => cb(null));
    }
    const run = (prev ?? Promise.resolve()).then(
      () => cb({ name }),
      () => cb({ name })
    );
    // Keep the chain alive until cb settles, then prune if we're the tail.
    const settled = run.then(
      () => {},
      () => {}
    );
    this.#chains.set(name, settled);
    void settled.then(() => {
      if (this.#chains.get(name) === settled) this.#chains.delete(name);
    });
    return run;
  }
}

import { atomicWriteWithRoot, removeFileWithRoot } from '../../src/admin/opfs-worker.ts';
import type { WriteRequest, WriteResponse } from '../../src/admin/opfs-worker-msg.ts';

/** Install navigator.storage + navigator.locks with a stable proxy
 * root, then return { mockRoot getter, resetMockOpfs, setFault,
 * setGate, setNoSyncHandle } for per-test use.
 *
 * Also installs a global Worker mock (routes writes to the actual
 * worker functions) and a minimal location stub so opfs.ts's write
 * dispatch works in Node without a real browser Worker.
 *
 * Call this ONCE at module level (before any dynamic imports of
 * opfs.ts / opfs-schema.ts), then call resetMockOpfs() in beforeEach. */
export function installMockOpfs(): {
  getMockRoot: () => MockDirHandleImpl;
  resetMockOpfs: () => void;
  setFault: (fn: FaultFn) => void;
  setGate: (fn: GateFn) => void;
  setNoSyncHandle: (fn: NoSyncHandleFn) => void;
} {
  let fault: FaultFn = null;
  const getFault = (): FaultFn => fault;
  let gate: GateFn = null;
  const getGate = (): GateFn => gate;
  let noSyncHandle: NoSyncHandleFn = null;
  const getNoSyncHandle = (): NoSyncHandleFn => noSyncHandle;

  let mockRoot = new MockDirHandleImpl('', '', getFault, getGate, getNoSyncHandle);

  const stableRoot = new MockDirHandleImpl('', '', getFault, getGate, getNoSyncHandle);
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
      },
      locks: new MockLockManager()
    }
  });

  // Worker mock: routes postMessage calls to the real worker functions
  // using the stable mock root proxy. Lets opfs.ts's write path work in
  // Node without a real browser Worker environment.
  class MockWorker {
    onmessage: ((event: { data: WriteResponse }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    postMessage(msg: unknown, _transfer?: Transferable[]): void {
      const req = msg as WriteRequest;
      void (async () => {
        try {
          if (req.op === 'write') await atomicWriteWithRoot(mockRootProxy, req.path, req.data);
          if (req.op === 'remove') await removeFileWithRoot(mockRootProxy, req.path);
          const res: WriteResponse = { id: req.id, ok: true };
          this.onmessage?.({ data: res });
        } catch (e) {
          const err = e as Error;
          const res: WriteResponse = {
            id: req.id,
            ok: false,
            error: err.message,
            isCapabilityError: err instanceof TypeError || err instanceof DOMException
          };
          this.onmessage?.({ data: res });
        }
      })();
    }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: MockWorker });

  // Minimal location stub so `new URL(path, location.origin)` in opfs.ts
  // doesn't throw when Worker is constructed in a Node test environment.
  if (typeof location === 'undefined') {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'http://localhost' }
    });
  }

  return {
    getMockRoot: () => mockRoot,
    resetMockOpfs: () => {
      mockRoot = new MockDirHandleImpl('', '', getFault, getGate, getNoSyncHandle);
      fault = null;
      gate = null;
      noSyncHandle = null;
    },
    setFault: (fn: FaultFn) => {
      fault = fn;
    },
    setGate: (fn: GateFn) => {
      gate = fn;
    },
    setNoSyncHandle: (fn: NoSyncHandleFn) => {
      noSyncHandle = fn;
    }
  };
}
