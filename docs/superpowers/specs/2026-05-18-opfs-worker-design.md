# OPFS Worker — Design Spec

**Date:** 2026-05-18  
**Status:** Approved  
**Scope:** Move all OPFS file writes into a dedicated Web Worker using
`createSyncAccessHandle()`, unifying the write path across desktop and iOS.

---

## Problem

`FileSystemFileHandle.createWritable()` is the current write mechanism in
`opfs.ts`. On iOS, this method exists on the `FileSystemFileHandle` prototype
for picker-based files (Safari 17.4+) but is never wired up for OPFS handles
obtained via `navigator.storage.getDirectory()`. This causes a runtime
`TypeError` on every iOS device regardless of OS version, breaking offline
draft persistence and silently killing online-state detection (because
`startOnline()` was only called in the OPFS success path).

`createSyncAccessHandle()` — the correct OPFS write API — is available in
all browsers that support OPFS writes: Chrome 102+, Firefox 111+, Safari 17+
(iOS 17+). iOS 16 continues to fall back to online-only mode.

---

## Approach

**Option A — Worker as pure I/O executor.** The worker owns raw file
operations only. Business logic, locking (`navigator.locks`), and reads stay
on the main thread unchanged. Nothing above `opfs.ts` is modified.

---

## Architecture

```
main thread                            dedicated worker
──────────────────────────────────────────────────────
opfs-schema.ts  ──┐
outbox.ts         ├─▶  opfs.ts (client)  ──postMessage──▶  opfs-worker.ts
draft.ts        ──┘    reads (unchanged)  ◀──postMessage──  (write I/O only)
```

### New / changed files

| File | Change |
|------|--------|
| `src/admin/opfs-worker.ts` | **New.** Dedicated worker. Owns `atomicWrite` and `removeFile` using `createSyncAccessHandle()`. |
| `src/admin/opfs-worker-msg.ts` | **New.** Shared message types for main ↔ worker protocol. |
| `src/admin/opfs.ts` | **Modified.** `atomicWrite` and `removeFile` become `postMessage` dispatchers. Reads and `isSupported` unchanged. |
| `tsconfig.worker.json` | **New.** `lib: ["webworker", "es2022"]` for the worker bundle. |
| `package.json` (build:admin) | **Modified.** Second esbuild call for the worker bundle. |
| `tsconfig.browser.json` | **Modified.** Exclude `opfs-worker.ts`. |
| `.githooks/pre-commit` | **Modified.** Add `tsc -p tsconfig.worker.json --noEmit`. |
| `knip.config.ts` | **Modified.** Add `opfs-worker.ts` as entry point. |
| `test/admin/opfs-worker.test.ts` | **New.** Unit tests for worker write logic. |

---

## Message Protocol

Defined in `opfs-worker-msg.ts`, imported by both sides.

```typescript
export type WriteRequest =
  | { id: string; op: 'write'; path: string; data: string | ArrayBuffer }
  | { id: string; op: 'remove'; path: string };

export type WriteResponse =
  | { id: string; ok: true }
  | { id: string; ok: false; error: string; isTypeError: boolean };
```

- `id` — `crypto.randomUUID()` generated per request on the main thread.
  Allows concurrent in-flight requests without a queue.
- `data` — Blob inputs are converted to `ArrayBuffer` on the main thread
  before dispatch (universally transferable, zero-copy via Transferable).
- `isTypeError` — set by the worker when `e instanceof TypeError`, signals
  a capability gap rather than a transient I/O error.

---

## Worker Internals (`opfs-worker.ts`)

### Atomic write sequence

1. Walk `path` → `{ parent: FileSystemDirectoryHandle, leafName: string }`
2. Create tmp handle: `parent.getFileHandle('.leafName.tmp-<uuid>', { create: true })`
3. `const sa = await tmpHandle.createSyncAccessHandle()`
4. Encode: string → `TextEncoder().encode(data)`, ArrayBuffer → `new Uint8Array(data)`
5. `sa.write(bytes, { at: 0 }); sa.flush(); sa.close()`
6. `await tmpHandle.move(parent, leafName)` — atomic rename

`createSyncAccessHandle()` returns a promise; the handle itself is
synchronous. Steps 4–5 run sync on the worker thread, never blocking the
main thread.

### Remove sequence

1. Walk `path` → `{ parent, leafName }`
2. `await parent.removeEntry(leafName)`
3. Silent on not-found (matches current behaviour)

### Message handler

```
self.onmessage = async ({ data: req }) => {
  try {
    if (req.op === 'write') await atomicWrite(req.path, req.data);
    if (req.op === 'remove') await removeFile(req.path);
    self.postMessage({ id: req.id, ok: true });
  } catch (e) {
    self.postMessage({ id: req.id, ok: false,
      error: e.message, isTypeError: e instanceof TypeError });
  }
};
```

---

## Main-Thread Client (`opfs.ts` changes)

### Worker lifecycle

```typescript
let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(
      new URL('/static/admin/opfs-worker.js', location.origin),
      { type: 'module' }
    );
    worker.onerror = () => { markOpfsUnsupported(); worker = null; };
    worker.onmessage = ({ data }) => settle(data);
  }
  return worker;
}
```

Worker is created lazily on first write. `onerror` fires if the script fails
to load (404, CSP block); it marks OPFS unsupported so `ensureSchema`'s
fallback path fires.

### Request dispatch

```typescript
const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();

function settle(res: WriteResponse): void {
  const p = pending.get(res.id);
  if (!p) return;
  pending.delete(res.id);
  if (res.ok) { p.resolve(); return; }
  if (res.isTypeError) markOpfsUnsupported();
  p.reject(new Error(res.error));
}

function workerRequest(req: Omit<WriteRequest, 'id'>): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    const msg = { ...req, id };
    const transfer = msg.data instanceof ArrayBuffer ? [msg.data] : [];
    getWorker().postMessage(msg, transfer);
  });
}
```

### Rewritten functions

```typescript
async function atomicWrite(path: string, data: string | Blob): Promise<void> {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
  await workerRequest({ op: 'write', path, data: buffer });
}

export async function removeFile(path: string): Promise<void> {
  if (!isSupported()) return;
  await workerRequest({ op: 'remove', path });
}
```

`walk` and `getRoot`/`rootCached` are duplicated into the worker (which needs
them for write-path navigation). The copies in `opfs.ts` are kept for the
read functions (`readJson`, `readBlob`, `listDir`) which still use them on
the main thread.

---

## Build Changes

### `tsconfig.worker.json`

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["webworker", "es2022"],
    "noEmit": true
  },
  "include": [
    "src/admin/opfs-worker.ts",
    "src/admin/opfs-worker-msg.ts"
  ]
}
```

### `build:admin` script (package.json)

Add a second esbuild invocation after the existing one:

```
esbuild src/admin/opfs-worker.ts \
  --bundle --format=esm --target=es2022 \
  --outdir=static/admin --entry-names=[name] \
  --minify --sourcemap
```

No `--splitting` — the worker bundle is self-contained.

### Other config changes

- `tsconfig.browser.json` — add `opfs-worker.ts` and `opfs-worker-msg.ts`
  to `exclude` (they live under the worker tsconfig).
- `.githooks/pre-commit` — add `tsc -p tsconfig.worker.json --noEmit` to
  the tsc step.
- `knip.config.ts` — add `src/admin/opfs-worker.ts` to `entry`.

---

## Error Handling

| Scenario | Worker response | Main-thread action |
|----------|----------------|--------------------|
| `createSyncAccessHandle` absent (iOS 16) | `{ ok: false, isTypeError: true }` | `markOpfsUnsupported()` → `ensureSchema` returns `unsupported` → online-only fallback |
| Worker script fails to load | `worker.onerror` fires | `markOpfsUnsupported()` → same fallback |
| Transient error (quota, disk full) | `{ ok: false, isTypeError: false }` | Reject propagates to caller; `startup.ts` shows error status |

The `ensureSchema` TypeError catch added in the previous fix handles all
three paths uniformly from the caller's perspective. `startOnline()` always
runs (moved to before the try/catch in a prior commit).

---

## Testing

### Unit tests (`test/admin/opfs-worker.test.ts`)

The worker's `atomicWrite` and `removeFile` functions are extracted as
pure functions accepting a `FileSystemDirectoryHandle` root. They are
imported and tested in Node using the existing `opfs-mock.ts` harness —
no real worker is spun up.

Covered cases:
- Successful write round-trip (mock handle, no fault)
- `TypeError` on `createSyncAccessHandle` → `isTypeError: true` in response
- Transient fault injected via `mockFault` → `isTypeError: false` in response

### Existing tests

- `opfs.test.ts` and `opfs-schema.test.ts` — pass unchanged; business logic
  and locking are untouched.
- E2e suite — covers full save/load/sync flows through the real built bundle,
  exercising the worker dispatch layer end-to-end.

---

## Out of scope

- Moving reads into the worker (reads work fine on the main thread)
- Moving `navigator.locks` into the worker (locks work fine on the main thread)
- Supporting iOS 16 offline writes (online-only fallback is acceptable)
- SharedWorker (locking already handles cross-tab coordination)
