# OPFS Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all OPFS file writes into a dedicated Web Worker using `createSyncAccessHandle()`, fixing iOS write failures and unifying the write path across all platforms.

**Architecture:** Option A — Worker as pure I/O executor. `opfs-worker.ts` owns `atomicWrite` and `removeFile` via `createSyncAccessHandle()`. Main thread `opfs.ts` replaces those functions with `postMessage` dispatchers. Reads, locking, and `isSupported` stay on the main thread unchanged. Nothing above `opfs.ts` is modified.

**Tech Stack:** TypeScript, esbuild (worker bundle), Web Workers API, `FileSystemSyncAccessHandle`, Node test runner for unit tests.

---

## File Map

| File | Action |
|------|--------|
| `test/admin/opfs-mock.ts` | Modify — add `MockSyncHandle`, `createSyncAccessHandle()`, `setNoSyncHandle` seam |
| `tsconfig.e2e.json` | Modify — add `"webworker"` to lib so test imports of opfs-worker.ts typecheck |
| `src/admin/opfs-worker-msg.ts` | Create — shared message types for main ↔ worker protocol |
| `test/admin/opfs-worker.test.ts` | Create — unit tests for `atomicWriteWithRoot` / `removeFileWithRoot` |
| `src/admin/opfs-worker.ts` | Create — worker; owns write I/O using `createSyncAccessHandle()` |
| `src/admin/opfs.ts` | Modify — replace `atomicWrite`/`removeFile` with worker dispatch |
| `package.json` | Modify — add worker esbuild call to `build:admin`; add `opfs-worker.ts` to knip `entry` |

---

## Task 1: Extend opfs-mock with createSyncAccessHandle support

**Files:**
- Modify: `test/admin/opfs-mock.ts`
- Modify: `tsconfig.e2e.json`

- [ ] **Step 1: Add `MockSyncHandle` interface and `MockSyncHandleImpl` class to opfs-mock.ts**

After the `MockWritableImpl` class (after line 103), insert:

```typescript
export interface MockSyncHandle {
  write(data: BufferSource, opts?: { at?: number }): number;
  flush(): void;
  close(): void;
}

export type NoSyncHandleFn = (() => boolean) | null;

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
```

- [ ] **Step 2: Add `createSyncAccessHandle()` to `MockFileHandle` interface**

In the `MockFileHandle` interface (around line 30), add:

```typescript
  createSyncAccessHandle(): Promise<MockSyncHandle>;
```

- [ ] **Step 3: Add `getNoSyncHandle` parameter to `MockFileHandleImpl` and wire `createSyncAccessHandle`**

In `MockFileHandleImpl`, add the `#getNoSyncHandle` field and update the constructor signature:

```typescript
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
```

Then add the method after `getFile()`:

```typescript
  async createSyncAccessHandle(): Promise<MockSyncHandle> {
    if (this.#getNoSyncHandle()?.()) {
      throw new TypeError('createSyncAccessHandle: not available');
    }
    if (this.#getFault()?.(this.file.path)) {
      throw new Error(`injected sync fault: ${this.file.path}`);
    }
    return new MockSyncHandleImpl(this.file);
  }
```

- [ ] **Step 4: Add `getNoSyncHandle` to `MockDirHandleImpl` and propagate to child handles**

In `MockDirHandleImpl`, add the field and update constructor:

```typescript
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
```

In `getDirectoryHandle`, pass `this.#getNoSyncHandle` to new `MockDirHandleImpl`:

```typescript
    const d = new MockDirHandleImpl(name, `${this.path}/${name}`, this.#getFault, this.#getGate, this.#getNoSyncHandle);
```

In `getFileHandle`, pass `this.#getNoSyncHandle` to new `MockFileHandleImpl`:

```typescript
    const h = new MockFileHandleImpl(
      name,
      new MockFileImpl(`${this.path}/${name}`),
      this.#getFault,
      this.#getGate,
      this.#getNoSyncHandle
    );
```

- [ ] **Step 5: Add `setNoSyncHandle` to `installMockOpfs` return**

In `installMockOpfs`, add the variable and getter:

```typescript
  let noSyncHandle: NoSyncHandleFn = null;
  const getNoSyncHandle = (): NoSyncHandleFn => noSyncHandle;
```

Update `mockRoot` and `stableRoot` construction to pass `getNoSyncHandle`:

```typescript
  let mockRoot = new MockDirHandleImpl('', '', getFault, getGate, getNoSyncHandle);
  const stableRoot = new MockDirHandleImpl('', '', getFault, getGate, getNoSyncHandle);
```

In `resetMockOpfs`, reset it:

```typescript
      mockRoot = new MockDirHandleImpl('', '', getFault, getGate, getNoSyncHandle);
      fault = null;
      gate = null;
      noSyncHandle = null;
```

Add `setNoSyncHandle` to the return type and object:

```typescript
  setNoSyncHandle: (fn: NoSyncHandleFn) => void;
```

```typescript
    setNoSyncHandle: (fn: NoSyncHandleFn) => {
      noSyncHandle = fn;
    }
```

- [ ] **Step 6: Add `webworker` to `tsconfig.e2e.json`**

Change the lib array:

```json
"lib": ["es2023", "dom", "dom.iterable", "webworker"],
```

- [ ] **Step 7: Run the existing test suite to verify no regressions**

```bash
cd /home/john/src/rkr-blog
node --no-warnings=ExperimentalWarning --experimental-strip-types --test 'test/admin/opfs*.test.ts'
```

Expected: all opfs tests pass.

- [ ] **Step 8: Commit**

```bash
git add test/admin/opfs-mock.ts tsconfig.e2e.json
git commit -m "test(opfs-mock): add createSyncAccessHandle support and setNoSyncHandle seam"
```

---

## Task 2: Create message types

**Files:**
- Create: `src/admin/opfs-worker-msg.ts`

- [ ] **Step 1: Create the file**

```typescript
export type WriteRequest =
  | { id: string; op: 'write'; path: string; data: string | ArrayBuffer }
  | { id: string; op: 'remove'; path: string };

export type WriteResponse =
  | { id: string; ok: true }
  | { id: string; ok: false; error: string; isTypeError: boolean };
```

- [ ] **Step 2: Typecheck**

```bash
npx --no-install tsc -p tsconfig.browser.json --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/admin/opfs-worker-msg.ts
git commit -m "feat(opfs): add worker message types"
```

---

## Task 3: Write failing tests for opfs-worker

**Files:**
- Create: `test/admin/opfs-worker.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { installMockOpfs } from './opfs-mock.ts';
import { atomicWriteWithRoot, removeFileWithRoot } from '../../src/admin/opfs-worker.ts';

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

  it('cleans up temp on failure', async () => {
    setFault(() => true);
    const root = getMockRoot() as unknown as FileSystemDirectoryHandle;
    try { await atomicWriteWithRoot(root, 'x.txt', 'y'); } catch { /* expected */ }
    // No .tmp files left
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
```

- [ ] **Step 2: Run to verify tests fail with module-not-found**

```bash
node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/admin/opfs-worker.test.ts
```

Expected: error — `opfs-worker.ts` doesn't exist yet.

---

## Task 4: Implement opfs-worker.ts

**Files:**
- Create: `src/admin/opfs-worker.ts`

- [ ] **Step 1: Create the file**

```typescript
import type { WriteRequest, WriteResponse } from './opfs-worker-msg.ts';

let rootCached: Promise<FileSystemDirectoryHandle> | null = null;

function getRoot(): Promise<FileSystemDirectoryHandle> {
  if (!rootCached) rootCached = navigator.storage.getDirectory();
  return rootCached;
}

async function walk(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean
): Promise<{ parent: FileSystemDirectoryHandle; leafName: string }> {
  const parts = path.split('/').filter((p) => p.length > 0);
  /* v8 ignore next 3 */
  if (parts.length === 0) throw new Error('opfs-worker: empty path');
  const leafName = parts.pop() as string;
  let parent = root;
  for (const segment of parts) {
    parent = await parent.getDirectoryHandle(segment, { create });
  }
  return { parent, leafName };
}

type MovableHandle = FileSystemFileHandle & {
  move(parent: FileSystemDirectoryHandle, name: string): Promise<void>;
};

export async function atomicWriteWithRoot(
  root: FileSystemDirectoryHandle,
  path: string,
  data: string | ArrayBuffer
): Promise<void> {
  const { parent, leafName } = await walk(root, path, true);
  const tmpName = `.${leafName}.tmp-${crypto.randomUUID()}`;
  const tmpHandle = await parent.getFileHandle(tmpName, { create: true });
  try {
    const sa = await tmpHandle.createSyncAccessHandle();
    const bytes =
      typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    sa.write(bytes, { at: 0 });
    sa.flush();
    sa.close();
  } catch (err) {
    await parent.removeEntry(tmpName).catch(() => {});
    throw err;
  }
  await (tmpHandle as MovableHandle).move(parent, leafName);
}

export async function removeFileWithRoot(
  root: FileSystemDirectoryHandle,
  path: string
): Promise<void> {
  let parent: FileSystemDirectoryHandle;
  let leafName: string;
  try {
    ({ parent, leafName } = await walk(root, path, false));
  } catch {
    return;
  }
  try {
    await parent.removeEntry(leafName);
  } catch {
    /* already gone — fine */
  }
}

/* v8 ignore next 18 -- worker runtime; exercised by e2e */
self.onmessage = async ({ data: req }: MessageEvent<WriteRequest>) => {
  const root = await getRoot();
  try {
    if (req.op === 'write') await atomicWriteWithRoot(root, req.path, req.data);
    if (req.op === 'remove') await removeFileWithRoot(root, req.path);
    const res: WriteResponse = { id: req.id, ok: true };
    self.postMessage(res);
  } catch (e) {
    const err = e as Error;
    const res: WriteResponse = {
      id: req.id,
      ok: false,
      error: err.message,
      isTypeError: err instanceof TypeError
    };
    self.postMessage(res);
  }
};
```

- [ ] **Step 2: Run the tests**

```bash
node --no-warnings=ExperimentalWarning --experimental-strip-types --test test/admin/opfs-worker.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 3: Typecheck**

```bash
npx --no-install tsc -p tsconfig.browser.json --noEmit && npx --no-install tsc -p tsconfig.e2e.json --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/admin/opfs-worker.ts src/admin/opfs-worker-msg.ts test/admin/opfs-worker.test.ts
git commit -m "feat(opfs): add opfs-worker with createSyncAccessHandle write path (TDD)"
```

---

## Task 5: Update opfs.ts — worker dispatcher

**Files:**
- Modify: `src/admin/opfs.ts`

- [ ] **Step 1: Remove the old write-path code**

Delete lines 72–117 (the `MovableFileHandle` type and the `atomicWrite` function that uses `createWritable`). The range to remove is from:

```typescript
/** Atomic write: stage into a sibling temp file then swap it into
```

down to and including the closing `}` of `atomicWrite`.

Also delete lines 228–244 (the old `removeFile` export):

```typescript
/** Remove a single file. Silent on "doesn't exist" — callers
 * dropping a possibly-already-drained outbox entry shouldn't have
 * to differentiate. */
export async function removeFile(path: string): Promise<void> {
  if (!isSupported()) return;
  ...
}
```

- [ ] **Step 2: Add the import for message types**

At the top of the file (after the existing comment block, before the `let supportedCached` declaration), add:

```typescript
import type { WriteRequest, WriteResponse } from './opfs-worker-msg.ts';
```

- [ ] **Step 3: Add worker state and helpers after `markOpfsUnsupported`**

After the `markOpfsUnsupported` function (around line 34), insert:

```typescript
let worker: Worker | null = null;

/* v8 ignore next 10 -- Worker() requires a real browser */
function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(
      new URL('/static/admin/opfs-worker.js', location.origin),
      { type: 'module' }
    );
    worker.onerror = () => {
      markOpfsUnsupported();
      worker = null;
    };
    worker.onmessage = ({ data }: MessageEvent<WriteResponse>) => settle(data);
  }
  return worker;
}

const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();

/* v8 ignore next 9 -- worker response path; exercised by e2e */
function settle(res: WriteResponse): void {
  const p = pending.get(res.id);
  if (!p) return;
  pending.delete(res.id);
  if (res.ok) { p.resolve(); return; }
  if (res.isTypeError) markOpfsUnsupported();
  p.reject(new Error(res.error));
}

/* v8 ignore next 8 -- Worker.postMessage; exercised by e2e */
function workerRequest(req: Omit<WriteRequest, 'id'>): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    const msg = { ...req, id };
    const transfer = 'data' in msg && msg.data instanceof ArrayBuffer ? [msg.data] : [];
    getWorker().postMessage(msg, transfer);
  });
}

/* v8 ignore next 4 -- worker dispatch; exercised by e2e */
async function atomicWrite(path: string, data: string | Blob): Promise<void> {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
  await workerRequest({ op: 'write', path, data: buffer });
}
```

- [ ] **Step 4: Add the new `removeFile` export**

At the end of the file, add:

```typescript
/** Remove a single file. Silent on "doesn't exist" — callers
 * dropping a possibly-already-drained outbox entry shouldn't have
 * to differentiate. */
/* v8 ignore next 4 -- worker dispatch; exercised by e2e */
export async function removeFile(path: string): Promise<void> {
  if (!isSupported()) return;
  await workerRequest({ op: 'remove', path });
}
```

- [ ] **Step 5: Typecheck and run full unit tests**

```bash
npx --no-install tsc -p tsconfig.browser.json --noEmit && npx --no-install tsc -p tsconfig.e2e.json --noEmit
node --no-warnings=ExperimentalWarning --experimental-strip-types --test 'test/admin/*.test.ts'
```

Expected: no type errors; all tests pass (opfs, opfs-schema, opfs-worker).

- [ ] **Step 6: Commit**

```bash
git add src/admin/opfs.ts
git commit -m "feat(opfs): replace atomicWrite/removeFile with worker dispatch"
```

---

## Task 6: Wire build config

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add worker esbuild call to `build:admin`**

In `package.json`, change the `build:admin` script from:

```
"build:admin": "rm -rf static/admin && esbuild src/admin/main.ts src/admin/posts-list.ts src/admin/settings-page.ts --bundle --splitting --format=esm --target=es2022 --outdir=static/admin --entry-names=[name] --minify --sourcemap",
```

to:

```
"build:admin": "rm -rf static/admin && esbuild src/admin/main.ts src/admin/posts-list.ts src/admin/settings-page.ts --bundle --splitting --format=esm --target=es2022 --outdir=static/admin --entry-names=[name] --minify --sourcemap && esbuild src/admin/opfs-worker.ts --bundle --format=esm --target=es2022 --outdir=static/admin --entry-names=[name] --minify --sourcemap",
```

Note: no `--splitting` on the worker — it must be a self-contained bundle.

- [ ] **Step 2: Add `opfs-worker.ts` to knip entry**

In the `"knip"` section of `package.json`, add to the `"entry"` array:

```json
"src/admin/opfs-worker.ts",
```

Place it after the other `src/admin/` entries.

- [ ] **Step 3: Build and verify**

```bash
npm run build:admin
ls static/admin/opfs-worker.js
```

Expected: file exists.

- [ ] **Step 4: Run knip to verify no dead-code errors**

```bash
npm run knip:gate
```

Expected: no output / zero findings.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "build: add opfs-worker.ts esbuild entry and knip registration"
```

---

## Task 7: Run the full gauntlet and commit

- [ ] **Step 1: Run unit tests with coverage**

```bash
npm run test:coverage
```

Expected: all pass, coverage thresholds met.

- [ ] **Step 2: Build bundles**

```bash
npm run build:admin && npm run build:site
```

Expected: builds succeed, `static/admin/opfs-worker.js` present.

- [ ] **Step 3: Run e2e tests**

```bash
npm run test:e2e
```

Expected: all e2e specs pass.

- [ ] **Step 4: Update bundle-size baseline if needed**

If `check-bundle-size.ts` flags growth (the new worker file adds ~3–5 KB), run it to re-baseline:

```bash
node --no-warnings=ExperimentalWarning --experimental-strip-types scripts/check-bundle-size.ts
```

If it auto-updates `scripts/bundle-size-baseline.json`, stage that file.

- [ ] **Step 5: Final commit + push + deploy**

```bash
git add -p  # stage any unstaged baseline updates
git commit -m "chore: update bundle-size baseline for opfs-worker"  # only if needed
git push
deploy.sh update .
```

---

## Self-review

**Spec coverage:**
- ✅ `createSyncAccessHandle()` write path in worker (Tasks 4)
- ✅ Worker as pure I/O executor, reads unchanged (Task 5 preserves readJson/readBlob/listDir)
- ✅ Message protocol WriteRequest/WriteResponse (Task 2)
- ✅ Worker lifecycle lazy-init + onerror → markOpfsUnsupported (Task 5)
- ✅ isTypeError flag propagation (Task 5 settle())
- ✅ Atomic rename via move() (Task 4)
- ✅ Cleanup temp on write failure (Task 4)
- ✅ Unit tests: success, TypeError, transient fault, cleanup (Task 3)
- ✅ Build wiring (Task 6)
- ✅ knip entry (Task 6)
- ✅ tsconfig.e2e.json webworker lib (Task 1)

**Placeholder scan:** None found.

**Type consistency:** `WriteRequest`/`WriteResponse` defined in Task 2, used in Tasks 4 and 5. `atomicWriteWithRoot`/`removeFileWithRoot` defined in Task 4, tested in Task 3. `MockSyncHandle`/`NoSyncHandleFn` defined in Task 1, used in Task 3.
