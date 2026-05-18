// Shared in-memory OPFS mock for unit tests.
//
// Models the slice of the File System Access API that src/admin/opfs.ts
// touches: directory/file handles, createWritable (truncates on open,
// like the real API), getFile, removeEntry, keys, and atomic move().
// A fault seam (mockFault) lets tests make a specific write() throw.
//
// opfs.ts caches the OPFS root promise once. This module exports a
// stable proxy whose methods always delegate to the current mockRoot,
// so each test can call resetMockOpfs() without defeating the cache.
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
  write(data: string | Blob): Promise<void>;
  close(): Promise<void>;
}

export interface MockFileHandle {
  kind: 'file';
  name: string;
  createWritable(): Promise<MockWritable>;
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
  #buf: Array<string | Blob> = [];
  #fault: () => FaultFn;
  #gate: () => GateFn;
  constructor(file: MockFileImpl, getFault: () => FaultFn, getGate: () => GateFn = () => null) {
    this.#file = file;
    this.#fault = getFault;
    this.#gate = getGate;
    this.#file.contents = '';
    this.#file.blob = null;
  }
  async write(data: string | Blob): Promise<void> {
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
    } else {
      this.#file.contents = this.#buf.join('');
      this.#file.blob = null;
    }
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
  constructor(
    name: string,
    file: MockFileImpl,
    getFault: () => FaultFn,
    getGate: () => GateFn = () => null
  ) {
    this.name = name;
    this.file = file;
    this.#getFault = getFault;
    this.#getGate = getGate;
  }
  async createWritable(): Promise<MockWritable> {
    return new MockWritableImpl(this.file, this.#getFault, this.#getGate);
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
  constructor(
    name: string,
    path: string,
    getFault: () => FaultFn = () => null,
    getGate: () => GateFn = () => null
  ) {
    this.name = name;
    this.path = path;
    this.#getFault = getFault;
    this.#getGate = getGate;
  }
  async getDirectoryHandle(name: string, opts?: HandleOpts): Promise<MockDirHandle> {
    const existing = this.entries.get(name);
    if (existing && existing.kind === 'directory') return existing;
    if (!opts?.create) throw new Error(`NotFound: dir ${name}`);
    const d = new MockDirHandleImpl(name, `${this.path}/${name}`, this.#getFault, this.#getGate);
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
      this.#getGate
    );
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

/** Install navigator.storage + navigator.locks with a stable proxy
 * root, then return { mockRoot getter, resetMockOpfs, setFault } for
 * per-test use.
 *
 * Call this ONCE at module level (before any dynamic imports of
 * opfs.ts / opfs-schema.ts), then call resetMockOpfs() in beforeEach. */
export function installMockOpfs(): {
  getMockRoot: () => MockDirHandleImpl;
  resetMockOpfs: () => void;
  setFault: (fn: FaultFn) => void;
  setGate: (fn: GateFn) => void;
} {
  let fault: FaultFn = null;
  const getFault = (): FaultFn => fault;
  let gate: GateFn = null;
  const getGate = (): GateFn => gate;

  let mockRoot = new MockDirHandleImpl('', '', getFault, getGate);

  const stableRoot = new MockDirHandleImpl('', '', getFault, getGate);
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

  // isSupported() probes FileSystemFileHandle.prototype.createWritable to
  // detect iOS Safari <17. Expose a minimal stub so the check passes in Node.
  if (typeof (globalThis as Record<string, unknown>).FileSystemFileHandle === 'undefined') {
    Object.defineProperty(globalThis, 'FileSystemFileHandle', {
      configurable: true,
      value: class FileSystemFileHandle {
        createWritable(): void {}
      }
    });
  }

  return {
    getMockRoot: () => mockRoot,
    resetMockOpfs: () => {
      mockRoot = new MockDirHandleImpl('', '', getFault, getGate);
      fault = null;
      gate = null;
    },
    setFault: (fn: FaultFn) => {
      fault = fn;
    },
    setGate: (fn: GateFn) => {
      gate = fn;
    }
  };
}
