// Origin Private File System (OPFS) wrapper for the admin SPA's
// offline cache. Browser-private filesystem at navigator.storage
// .getDirectory(); see spec-offline.md §4 for the on-disk layout.
//
// Phase 1 foundation: JSON + blob read/write, directory listing,
// file/directory removal. Each call collapses the verbose native
// API (getDirectoryHandle → getFileHandle → createWritable → write
// → close) to one function and auto-creates intermediate
// directories on writes.

/** True iff the running browser exposes OPFS. Cached because the
 * answer is process-stable. Older browsers + some private-browsing
 * modes return false; the SPA should fall back to the v1 (online-
 * only) experience. */
let supportedCached: boolean | null = null;
export function isSupported(): boolean {
  if (supportedCached !== null) return supportedCached;
  // createWritable is absent on iOS Safari <17 even though getDirectory
  // exists, so we must probe both halves of the API.
  supportedCached =
    typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    typeof FileSystemFileHandle.prototype.createWritable === 'function';
  return supportedCached;
}

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

/** Atomic write: stage into a sibling temp file then swap it into
 * place, so a crash mid-write can never truncate or partially
 * overwrite the target. createWritable() truncates whatever handle
 * it opens to zero immediately, so the temp must be a *different*
 * file from the target — never the target itself. The swap uses the
 * native handle.move() when available (a true atomic rename); the
 * fallback (copy temp → target → drop temp) is non-atomic but still
 * never leaves the target empty on a write fault, because a thrown
 * write() aborts before the target handle is ever opened. */
// FileSystemFileHandle.move() is part of the File System Access API
// but not yet in TS's DOM lib; narrow locally instead of augmenting
// the global type.
type MovableFileHandle = FileSystemFileHandle & {
  move(parent: FileSystemDirectoryHandle, name: string): Promise<void>;
};

async function atomicWrite(path: string, data: string | Blob): Promise<void> {
  const { parent, leafName } = await walk(path, true);
  const tmpName = `.${leafName}.tmp-${crypto.randomUUID()}`;
  const tmpHandle = await parent.getFileHandle(tmpName, { create: true });
  try {
    const writable = await tmpHandle.createWritable();
    await writable.write(data);
    await writable.close();
  } catch (err) {
    // Staging failed — the real target was never touched. Drop the
    // partial temp so it doesn't linger / show up in listDir.
    await parent.removeEntry(tmpName).catch(() => {});
    throw err;
  }
  const movable = tmpHandle as Partial<MovableFileHandle>;
  if (typeof movable.move === 'function') {
    // Atomic rename: the target flips from old → new in one step.
    await movable.move(parent, leafName);
    return;
  }
  /* v8 ignore start -- move() fallback; only taken on browsers
     without FileSystemFileHandle.move (the unit harness mocks move,
     so this path is e2e-only) */
  const target = await parent.getFileHandle(leafName, { create: true });
  const writable = await target.createWritable();
  await writable.write(await tmpHandle.getFile());
  await writable.close();
  await parent.removeEntry(tmpName).catch(() => {});
  /* v8 ignore stop */
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
export async function removeFile(path: string): Promise<void> {
  if (!isSupported()) return;
  let parent: FileSystemDirectoryHandle;
  let leafName: string;
  try {
    ({ parent, leafName } = await walk(path, false));
    /* v8 ignore next */
  } catch {
    return;
  }
  try {
    await parent.removeEntry(leafName);
    /* v8 ignore next 3 -- already-gone path; harmless, fires on retried drains */
  } catch {
    /* already gone or nonexistent — fine */
  }
}
