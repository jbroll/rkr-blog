// Durable copy of the unified editor's unsaved tree, one record per slug
// in IndexedDB, so a failed save survives a reload. IndexedDB rather than
// OPFS: OPFS writes go through a worker that starts only after the schema
// is ready, and some iOS builds lack it; a draft must exist before the
// first request.
//
// Browser-safe: no node:* imports.

import type { BlockTree } from '../lib/blocks.ts';

export interface DraftRecord {
  tree: BlockTree;
  /** The stored version the tree was edited from. */
  baseVersion: string;
  savedAt: number;
}

export interface DraftStore {
  load(): Promise<DraftRecord | null>;
  put(record: DraftRecord): Promise<void>;
  /** Remove the draft; with `savedAt`, only if it is still that record,
   * so one tab's successful save can't drop another tab's newer draft. */
  clear(savedAt?: number): Promise<void>;
}

/** `op`'s result, or undefined once `ms` passes or it rejects. A storage
 * call that never settles (a blocked IndexedDB open) must not hold up a
 * save. */
export function within<T>(op: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    op.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      }
    );
  });
}

/** JSON with sorted keys, so equal trees compare equal whatever built them. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

const OP_TIMEOUT_MS = 500;
/** Cleared only by a confirmed sign-out (src/site/admin-signout.ts). */
const DRAFTS_DB = 'rkr-blocks-editor';
const STORE = 'drafts';

/* v8 ignore start -- IndexedDB needs a real browser; covered by the blocks e2e */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DRAFTS_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transact<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => T
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = op(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function isDraft(value: unknown): value is DraftRecord {
  const rec = value as Partial<DraftRecord> | null;
  return (
    !!rec &&
    typeof rec.baseVersion === 'string' &&
    typeof rec.savedAt === 'number' &&
    Array.isArray((rec.tree as { body?: unknown } | undefined)?.body)
  );
}

/** Every stored draft, keyed by slug. */
export async function listAllDrafts(): Promise<{ slug: string; tree: BlockTree }[]> {
  const db = await openDb();
  try {
    const entries: { slug: string; tree: BlockTree }[] = [];
    await transact(db, 'readonly', (store) => {
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        if (isDraft(at.value)) entries.push({ slug: String(at.key), tree: at.value.tree });
        at.continue();
      };
    });
    return entries;
  } finally {
    db.close();
  }
}

/** Remove every stored draft. Clearing the store, not deleting the
 * database, so an open editor tab cannot block it. */
export async function clearAllDrafts(): Promise<void> {
  const db = await openDb();
  try {
    await transact(db, 'readwrite', (store) => store.clear());
  } finally {
    db.close();
  }
}

export function indexedDbDraftStore(slug: string): DraftStore {
  let db: Promise<IDBDatabase> | null = null;
  // Chained so a clear issued after a put can never land before it. The
  // chain waits at most OP_TIMEOUT_MS per op, so one stuck op can't stall
  // the rest, and an open that hangs is retried on the next op.
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => T): Promise<T> => {
    const next = chain.then(async () => {
      db ??= openDb();
      const handle = await within(db, OP_TIMEOUT_MS);
      if (!handle) {
        db = null;
        throw new Error('draft store unavailable');
      }
      return transact(handle, mode, op);
    });
    chain = within(next, OP_TIMEOUT_MS);
    return next;
  };
  return {
    load: async () => {
      const req = await run('readonly', (store) => store.get(slug));
      return isDraft(req.result) ? req.result : null;
    },
    put: async (record) => {
      await run('readwrite', (store) => store.put(record, slug));
    },
    clear: async (savedAt) => {
      await run('readwrite', (store) => {
        if (savedAt === undefined) {
          store.delete(slug);
          return;
        }
        const req = store.get(slug);
        req.onsuccess = () => {
          if ((req.result as DraftRecord | undefined)?.savedAt === savedAt) store.delete(slug);
        };
      });
    }
  };
}
/* v8 ignore stop */
