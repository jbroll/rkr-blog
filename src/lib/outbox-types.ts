// Pure types + coalescing for the outbox. OPFS-coupled side lives
// in src/admin/outbox.ts; ops table is in spec-offline §5.

import type { SidecarOp } from './sidecar-types.ts';

/** @public */
export type OutboxOp = 'upload' | 'setOps' | 'bake' | 'savePost';

/** @public */
export interface SavePostPayload {
  /** Empty string for brand-new posts; the server slugifies the
   * title to fill it in. Existing posts loaded via pinPost carry
   * their original slug here. */
  slug: string;
  title: string;
  /** Optional secondary heading; written into the post's frontmatter
   * when non-empty. */
  subtitle?: string;
  /** Optional: when omitted, the server preserves the existing post's
   * status (or defaults to 'draft' for a fresh post). The editor no
   * longer carries the status select; status is edited per-row on
   * /admin/posts via POST /admin/posts/:slug/status. */
  status?: 'draft' | 'published';
  date?: string;
  markdown: string;
  /** Server-side updated_at the client saw at edit-start. Sent as
   * X-Rkr-Last-Synced-At; omitted for fresh never-synced posts. */
  lastSyncedAt?: string;
}

/** @public */
export interface SetOpsPayload {
  id: string;
  ops: SidecarOp[];
  redoStack: SidecarOp[];
}

/** @public */
export interface BakePayload {
  id: string;
  /** sha256 hex of canonicalJson(ops); X-Rkr-Bake-Ops-Hash header.
   * Bake bytes are in opfs://outbox-blobs/<seq>.bin. */
  opsHash: string;
}

/** @public */
export interface UploadPayload {
  /** Content-addressed sha256; client-computed so a savePost can
   * reference it before the upload drains. */
  id: string;
  filename: string;
  mimeType: string;
}

interface OutboxEntryBase {
  seq: number;
  createdAt: string;
  deviceId: string;
  draftId?: string;
}

export type OutboxEntry =
  | (OutboxEntryBase & { op: 'upload'; payload: UploadPayload })
  | (OutboxEntryBase & { op: 'setOps'; payload: SetOpsPayload })
  | (OutboxEntryBase & { op: 'bake'; payload: BakePayload })
  | (OutboxEntryBase & { op: 'savePost'; payload: SavePostPayload });

/** Keep only the latest savePost per slug + setOps per id. Upload
 * and bake are NOT coalesced — uploads are idempotent server-side
 * (content-addressed); bakes carry distinct ops-hashes that the
 * server validates separately. */
export function coalescePending(entries: readonly OutboxEntry[]): OutboxEntry[] {
  const latestSavePost = new Map<string, number>();
  const latestSetOps = new Map<string, number>();
  for (const e of entries) {
    if (e.op === 'savePost') {
      const prev = latestSavePost.get(e.payload.slug);
      if (prev === undefined || e.seq > prev) {
        latestSavePost.set(e.payload.slug, e.seq);
      }
    } else if (e.op === 'setOps') {
      const prev = latestSetOps.get(e.payload.id);
      if (prev === undefined || e.seq > prev) {
        latestSetOps.set(e.payload.id, e.seq);
      }
    }
  }
  return entries.filter((e) => {
    if (e.op === 'savePost') return latestSavePost.get(e.payload.slug) === e.seq;
    if (e.op === 'setOps') return latestSetOps.get(e.payload.id) === e.seq;
    return true;
  });
}
