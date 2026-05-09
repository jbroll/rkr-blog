// Origin Private File System (OPFS) wrapper for the admin SPA's
// offline cache. Browser-private filesystem at navigator.storage
// .getDirectory(); see spec-offline.md §4 for the on-disk layout.
//
// Phase 1 foundation: just the JSON read/write surface that the
// schema versioning module (opfs-schema.ts) needs. readBlob /
// writeBlob / listDir / removeFile / removeDir land in phase 1c+
// when their consumers (outbox, eviction) arrive — held back today
// per the no-speculative-API rule.

/** True iff the running browser exposes OPFS. Cached because the
 * answer is process-stable. Older browsers + some private-browsing
 * modes return false; the SPA should fall back to the v1 (online-
 * only) experience. */
let supportedCached: boolean | null = null;
export function isSupported(): boolean {
  if (supportedCached !== null) return supportedCached;
  supportedCached =
    typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.getDirectory === 'function';
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

/** Read a file as JSON. Returns null when the file doesn't exist;
 * throws on parse errors so silent corruption isn't masked. */
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
  return JSON.parse(text) as T;
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
  const { parent, leafName } = await walk(path, true);
  const handle = await parent.getFileHandle(leafName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(`${JSON.stringify(value, null, 2)}\n`);
  await writable.close();
}
