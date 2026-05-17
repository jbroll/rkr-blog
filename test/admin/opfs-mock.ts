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

export class MockWritableImpl implements MockWritable {
  #file: MockFileImpl;
  #buf: Array<string | Blob> = [];
  #fault: () => FaultFn;
  constructor(file: MockFileImpl, getFault: () => FaultFn) {
    this.#file = file;
    this.#fault = getFault;
    this.#file.contents = '';
    this.#file.blob = null;
  }
  async write(data: string | Blob): Promise<void> {
    if (this.#fault()?.(this.#file.path)) {
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

export class MockFileHandleImpl implements MockFileHandle {
  kind = 'file' as const;
  name: string;
  file: MockFileImpl;
  owner: MockDirHandleImpl | null = null;
  ownerName = '';
  #getFault: () => FaultFn;
  constructor(name: string, file: MockFileImpl, getFault: () => FaultFn) {
    this.name = name;
    this.file = file;
    this.#getFault = getFault;
  }
  async createWritable(): Promise<MockWritable> {
    return new MockWritableImpl(this.file, this.#getFault);
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
  constructor(name: string, path: string, getFault: () => FaultFn = () => null) {
    this.name = name;
    this.path = path;
    this.#getFault = getFault;
  }
  async getDirectoryHandle(name: string, opts?: HandleOpts): Promise<MockDirHandle> {
    const existing = this.entries.get(name);
    if (existing && existing.kind === 'directory') return existing;
    if (!opts?.create) throw new Error(`NotFound: dir ${name}`);
    const d = new MockDirHandleImpl(name, `${this.path}/${name}`, this.#getFault);
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
      this.#getFault
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

/** Install navigator.storage with a stable proxy root, then return
 * { mockRoot getter, resetMockOpfs, setFault } for per-test use.
 *
 * Call this ONCE at module level (before any dynamic imports of
 * opfs.ts / opfs-schema.ts), then call resetMockOpfs() in beforeEach. */
export function installMockOpfs(): {
  getMockRoot: () => MockDirHandleImpl;
  resetMockOpfs: () => void;
  setFault: (fn: FaultFn) => void;
} {
  let fault: FaultFn = null;
  const getFault = (): FaultFn => fault;

  let mockRoot = new MockDirHandleImpl('', '', getFault);

  const stableRoot = new MockDirHandleImpl('', '', getFault);
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

  return {
    getMockRoot: () => mockRoot,
    resetMockOpfs: () => {
      mockRoot = new MockDirHandleImpl('', '', getFault);
      fault = null;
    },
    setFault: (fn: FaultFn) => {
      fault = fn;
    }
  };
}
