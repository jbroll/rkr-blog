// Pure types + coalescing for the outbox. OPFS-coupled side lives
// in src/admin/outbox.ts; ops table is in spec-offline §5.

import type { SidecarOp } from './sidecar-types.ts';

/** @public */
export type OutboxOp = 'upload' | 'commitImageEdit' | 'savePost';

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
  /** Tag names to attach to the post. */
  tags?: string[];
}

/** @public */
export interface CommitImageEditPayload {
  id: string;
  ops: SidecarOp[];
  redoStack: SidecarOp[];
  /** True when the entry carries a bake blob in
   * opfs://outbox-blobs/<seq>.bin. False when ops is empty (clear-
   * edits save) — the server unlinks any existing bake instead. */
  hasBake: boolean;
  /** Server-side sidecar updated_at the client saw at edit-start
   * (from GET /admin/sidecar/:id/meta). Sent as x-rkr-sidecar-base so
   * a stale drained replay arriving after a newer same-image edit is
   * rejected (409 sidecar-superseded) instead of silently reverting.
   * Omitted for entries queued before this field existed → server
   * preserves legacy (no-409) behavior. */
  sidecarBase?: string;
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
  | (OutboxEntryBase & { op: 'commitImageEdit'; payload: CommitImageEditPayload })
  | (OutboxEntryBase & { op: 'savePost'; payload: SavePostPayload });

function savePostKey(e: Extract<OutboxEntry, { op: 'savePost' }>): string {
  // New, never-synced posts share slug '' — keying those by slug
  // collapses distinct posts into one and drops all but the latest.
  // Distinguish them by draftId. Existing posts key by their slug.
  return e.payload.slug !== '' ? `slug:${e.payload.slug}` : `draft:${e.draftId ?? `seq:${e.seq}`}`;
}

/** Keep only the latest savePost per slug, commitImageEdit per id,
 * and upload per id. The upload blob lives in originals/<id>.<ext>
 * (written once at ingest time), so draining N uploads of the same
 * image would send the same bytes N times; only the latest is needed. */
export function coalescePending(entries: readonly OutboxEntry[]): OutboxEntry[] {
  const latestSavePost = new Map<string, number>();
  const latestCommit = new Map<string, number>();
  const latestUpload = new Map<string, number>();
  for (const e of entries) {
    if (e.op === 'savePost') {
      const key = savePostKey(e);
      const prev = latestSavePost.get(key);
      if (prev === undefined || e.seq > prev) {
        latestSavePost.set(key, e.seq);
      }
    } else if (e.op === 'commitImageEdit') {
      const prev = latestCommit.get(e.payload.id);
      if (prev === undefined || e.seq > prev) {
        latestCommit.set(e.payload.id, e.seq);
      }
    } else if (e.op === 'upload') {
      const prev = latestUpload.get(e.payload.id);
      if (prev === undefined || e.seq > prev) {
        latestUpload.set(e.payload.id, e.seq);
      }
    }
  }
  return entries.filter((e) => {
    if (e.op === 'savePost') return latestSavePost.get(savePostKey(e)) === e.seq;
    if (e.op === 'commitImageEdit') return latestCommit.get(e.payload.id) === e.seq;
    if (e.op === 'upload') return latestUpload.get(e.payload.id) === e.seq;
    return true;
  });
}
