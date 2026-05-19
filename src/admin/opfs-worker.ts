// Dedicated OPFS write worker. Owns atomicWrite and removeFile.
// Primary path: createSyncAccessHandle() — synchronous, all platforms
// that support it (Chrome, Firefox, Safari 16.4+ in standard contexts).
// Fallback path: createWritable() — async writable stream available in
// workers on Safari/WebKit and in sandboxed test environments where
// createSyncAccessHandle() throws a DOMException. Main thread dispatches
// via postMessage; reads stay on the main thread unchanged.

import type { WriteRequest, WriteResponse } from './opfs-worker-msg.ts';

let rootCached: Promise<FileSystemDirectoryHandle> | null = null;

/* v8 ignore next 3 -- worker runtime */
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
  /* v8 ignore next 3 -- programming error; callers always pass real paths */
  if (parts.length === 0) throw new Error('opfs-worker: empty path');
  const leafName = parts.pop() as string;
  let parent = root;
  for (const segment of parts) {
    parent = await parent.getDirectoryHandle(segment, { create });
  }
  return { parent, leafName };
}

type SyncHandle = {
  write(data: BufferSource, opts?: { at?: number }): number;
  flush(): void;
  close(): void;
};

type MovableHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncHandle>;
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
  let syncErrDesc = '';
  let writableErrDesc = '';
  try {
    try {
      // Preferred: synchronous access handle (lower overhead, all
      // environments that fully support the OPFS worker API).
      const sa = await (tmpHandle as MovableHandle).createSyncAccessHandle();
      const bytes =
        typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
      sa.write(bytes, { at: 0 });
      sa.flush();
      sa.close();
    } catch (syncErr) {
      // createSyncAccessHandle() failed — record for diagnostics then try
      // the async writable-stream fallback.
      /* v8 ignore next 2 -- diagnostic path */
      const se = syncErr as Error;
      syncErrDesc = `${se.constructor.name}: ${se.message}`;
      const writable = await tmpHandle.createWritable();
      await writable.write(data);
      await writable.close();
    }
  } catch (err) {
    /* v8 ignore next 2 -- outer failure path */
    const e = err as Error;
    writableErrDesc = `${e.constructor.name}: ${e.message}`;
    await parent.removeEntry(tmpName).catch(() => {});
    const debug = syncErrDesc
      ? `syncHandle: ${syncErrDesc}; writable: ${writableErrDesc}`
      : writableErrDesc;
    const tagged = new Error(e.message) as Error & { debug?: string };
    tagged.debug = debug;
    Object.setPrototypeOf(tagged, Object.getPrototypeOf(e) as object);
    throw tagged;
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

/* v8 ignore next 19 -- worker runtime; exercised by e2e */
if (typeof self !== 'undefined') {
  self.onmessage = async ({ data: req }: MessageEvent<WriteRequest>) => {
    const root = await getRoot();
    try {
      if (req.op === 'write') await atomicWriteWithRoot(root, req.path, req.data);
      if (req.op === 'remove') await removeFileWithRoot(root, req.path);
      const res: WriteResponse = { id: req.id, ok: true };
      self.postMessage(res);
    } catch (e) {
      const err = e as Error;
      const debugErr = err as Error & { debug?: string };
      const res: WriteResponse = {
        id: req.id,
        ok: false,
        error: err.message,
        // TypeError = createSyncAccessHandle absent (old iOS).
        // DOMException = WebKit/Safari OPFS write broken at runtime.
        // Both mean OPFS writes are non-functional in this environment.
        isCapabilityError: err instanceof TypeError || err instanceof DOMException,
        debug: debugErr.debug
      };
      self.postMessage(res);
    }
  };
}
