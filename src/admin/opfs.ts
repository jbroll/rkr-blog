// Origin Private File System (OPFS) wrapper for the admin SPA's
// offline cache. Browser-private filesystem at navigator.storage
// .getDirectory(); see spec-offline.md §4 for the on-disk layout.
//
// Write path: dispatches to opfs-worker.ts via postMessage so all
// writes use createSyncAccessHandle() — the correct OPFS write API
// on iOS 17+ and all desktop browsers.
// Read path: JSON + blob reads, directory listing stay on main thread.

import type { WriteRequest, WriteRequestBody, WriteResponse } from './opfs-worker-msg.ts';

/** True iff the running browser exposes OPFS. Cached because the
 * answer is process-stable. Older browsers + some private-browsing
 * modes return false; the SPA should fall back to the v1 (online-
 * only) experience. */
let supportedCached: boolean | null = null;
export function isSupported(): boolean {
  if (supportedCached !== null) return supportedCached;
  // Probe getDirectory only. Runtime write failures (iOS devices where
  // createSyncAccessHandle is absent) are caught by the worker response
  // path, which calls markOpfsUnsupported() and returns { status: 'unsupported' }.
  supportedCached =
    typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.getDirectory === 'function';
  return supportedCached;
}

/** Called by ensureSchema() when a write proves OPFS non-functional at
 * runtime (e.g. createSyncAccessHandle absent on iOS 16). Flips the
 * cache so all subsequent isSupported() calls see false. */
export function markOpfsUnsupported(): void {
  supportedCached = false;
}

// ---------------------------------------------------------------------------
// Worker write path
// ---------------------------------------------------------------------------

let worker: Worker | null = null;

/* v8 ignore next 10 -- Worker() requires a real browser */
function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('/static/admin/opfs-worker.js', location.origin), {
      type: 'module'
    });
    worker.onerror = () => {
      // Drain all pending requests so callers don't hang forever.
      for (const { reject } of pending.values()) {
        reject(new Error('opfs worker crashed'));
      }
      pending.clear();
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
  if (res.ok) {
    p.resolve();
    return;
  }
  if (res.isCapabilityError) markOpfsUnsupported();
  /* v8 ignore next 2 -- diagnostic; remove once OPFS Safari issue resolved */
  console.error(
    `[opfs] worker error: ${res.error}${res.debug ? ` — ${res.debug}` : ''} (capability=${res.isCapabilityError})`
  );
  p.reject(new Error(res.error));
}

/* v8 ignore next 8 -- Worker.postMessage; exercised by e2e */
function workerRequest(req: WriteRequestBody): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    const msg = { ...req, id } as WriteRequest;
    const transfer: Transferable[] =
      msg.op === 'write' && msg.data instanceof ArrayBuffer ? [msg.data] : [];
    getWorker().postMessage(msg, transfer);
  });
}

/* v8 ignore next 4 -- worker dispatch; exercised by e2e */
async function atomicWrite(path: string, data: string | Blob): Promise<void> {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
  await workerRequest({ op: 'write', path, data: buffer });
}

// ---------------------------------------------------------------------------
// Read path (unchanged — reads work fine on the main thread)
// ---------------------------------------------------------------------------

/** Resolve the OPFS root. Cached per process so repeated lookups
 * don't repeatedly traverse the API. Throws when OPFS isn't
 * available — callers must gate on isSupported(). */
let rootCached: Promise<FileSystemDirectoryHandle> | null = null;
function getRoot(): Promise<FileSystemDirectoryHandle> {
  /* v8 ignore next 3 -- defensive guard; isSupported() gates upstream */
  if (!isSupported()) {
    throw new Error('OPFS not available; gate on isSupported() first');
  }
  if (!rootCached) {
    rootCached = navigator.storage.getDirectory();
  }
  return rootCached;
}

/** Walk a slash-separated path to the directory containing the leaf,
 * creating intermediate dirs when create=true. Returns {parent,
 * leafName}. Empty path components are skipped (so '/foo/bar' and
 * 'foo/bar' resolve identically). */
async function walk(
  path: string,
  create: boolean
): Promise<{ parent: FileSystemDirectoryHandle; leafName: string }> {
  const parts = path.split('/').filter((p) => p.length > 0);
  /* v8 ignore next 3 -- programming error; callers always pass real paths */
  if (parts.length === 0) {
    throw new Error(`opfs: empty path`);
  }
  const leafName = parts.pop() as string;
  let parent = await getRoot();
  for (const segment of parts) {
    parent = await parent.getDirectoryHandle(segment, { create });
  }
  return { parent, leafName };
}

/** Read a file as JSON. Returns null when the file doesn't exist.
 * Unparseable content (a crash-truncated file) is treated as absent:
 * it's quarantined (removed) and null is returned, rather than
 * throwing a SyntaxError that would wedge every caller iterating the
 * directory (e.g. outbox.list(), readRoot()). */
export async function readJson<T>(path: string): Promise<T | null> {
  if (!isSupported()) return null;
  let parent: FileSystemDirectoryHandle;
  let leafName: string;
  try {
    ({ parent, leafName } = await walk(path, false));
  } catch {
    return null;
  }
  let handle: FileSystemFileHandle;
  try {
    handle = await parent.getFileHandle(leafName, { create: false });
    /* v8 ignore next 3 -- not-found path; only fires when the dir
       walk succeeds but the leaf is gone (rare race) */
  } catch {
    return null;
  }
  const file = await handle.getFile();
  const text = await file.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Crash-truncated / corrupt JSON. Quarantine it so a single bad
    // file can't wedge outbox.list()/readRoot() forever: removing it
    // makes the next read see it as absent (→ null) instead of
    // re-throwing on every traversal.
    // Race: another tab could land a good atomicWrite between this
    // parse failure and this removeEntry, so we'd delete a freshly-
    // good file. Accepted: these are regenerable cache (next read
    // returns null and the system rebuilds), and the File System
    // Access API has no compare-and-delete to make this atomic.
    await parent.removeEntry(leafName).catch(() => {});
    return null;
  }
}

/** Write a value as pretty-printed JSON, creating intermediate
 * directories as needed. Pretty-printed because OPFS storage is
 * cheap and these files are sometimes hand-inspected via the
 * storage panel debug export. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  /* v8 ignore next 3 -- defensive guard; isSupported() gates upstream */
  if (!isSupported()) {
    throw new Error('writeJson called on unsupported browser');
  }
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Read a binary file as a Blob. Returns null when not present. */
export async function readBlob(path: string): Promise<Blob | null> {
  if (!isSupported()) return null;
  let parent: FileSystemDirectoryHandle;
  let leafName: string;
  try {
    ({ parent, leafName } = await walk(path, false));
    /* v8 ignore next 3 -- not-found path; only fires when the dir
       walk succeeds but the leaf is gone (rare race) */
  } catch {
    return null;
  }
  try {
    const handle = await parent.getFileHandle(leafName, { create: false });
    return await handle.getFile();
    /* v8 ignore next 3 -- not-found path; same shape as readJson's */
  } catch {
    return null;
  }
}

/** Write a binary blob, creating intermediate directories as needed. */
export async function writeBlob(path: string, blob: Blob): Promise<void> {
  /* v8 ignore next 3 -- defensive guard; isSupported() gates upstream */
  if (!isSupported()) {
    throw new Error('writeBlob called on unsupported browser');
  }
  await atomicWrite(path, blob);
}

/** List the names in a directory. Returns [] when the directory
 * doesn't exist (vs. throwing — callers iterating a possibly-empty
 * area shouldn't have to wrap in try/catch). */
export async function listDir(path: string): Promise<string[]> {
  if (!isSupported()) return [];
  const parts = path.split('/').filter((p) => p.length > 0);
  let dir = await getRoot();
  try {
    for (const segment of parts) {
      dir = await dir.getDirectoryHandle(segment, { create: false });
    }
    /* v8 ignore next 3 -- empty-dir / not-found path; covered indirectly */
  } catch {
    return [];
  }
  const out: string[] = [];
  for await (const name of dir.keys()) {
    out.push(name);
  }
  return out;
}

/** Remove a single file. Silent on "doesn't exist" — callers
 * dropping a possibly-already-drained outbox entry shouldn't have
 * to differentiate. */
/* v8 ignore next 4 -- worker dispatch; exercised by e2e */
export async function removeFile(path: string): Promise<void> {
  if (!isSupported()) return;
  await workerRequest({ op: 'remove', path });
}
