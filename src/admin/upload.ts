// Image upload — POST /admin/upload (online) or queue to the OPFS
// outbox (offline) so the user can keep authoring and the post-
// reconnect drain ingests the bytes. Used by the toolbar Image
// button, drag-drop, paste, and the Drive / OneDrive import flows.
//
// Identity is content-addressed (sha256 of the bytes); the same id
// the server would return is computed client-side via SubtleCrypto.
// That lets a `savePost` outbox entry reference the id immediately
// even though the upload entry hasn't drained yet — the seq order
// guarantees the upload drains first.

import { computeContentId, extForMime } from '../lib/content-id.ts';
import { getState } from './online-state.ts';
import { writeBlob } from './opfs.ts';
import { append as outboxAppend } from './outbox.ts';
import { tryDrain } from './sync.ts';

/** JSON returned by POST /admin/upload on success. */
export interface UploadResponse {
  id: string;
  bytes: number;
  ext: string;
  deduplicated: boolean;
}

export async function uploadImage(file: File): Promise<UploadResponse> {
  // Online path: same as before. Verifying state (initial mount /
  // probe-pending) tries the POST too — reachability is the truth.
  if (getState() !== 'offline') {
    try {
      return await postUpload(file);
    } catch {
      /* fall through to outbox queue on network failure */
    }
  }
  return queueUpload(file);
}

async function postUpload(file: File): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/admin/upload', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return (await res.json()) as UploadResponse;
}

/** Offline / fallback path: compute the content id client-side,
 * write the original to opfs://originals/<id>.<ext>, append an
 * `upload` outbox entry, return a synthetic UploadResponse so the
 * caller (toolbar / drag-drop) can insert a figure node referencing
 * the id immediately. The drainer in startup.ts POSTs the same blob
 * when connectivity returns. */
async function queueUpload(file: File): Promise<UploadResponse> {
  const id = await computeContentId(file);
  const ext = extForMime(file.type);
  await writeBlob(`originals/${id}.${ext}`, file);
  await outboxAppend({
    op: 'upload',
    payload: { id, filename: file.name, mimeType: file.type }
  });
  // Try to drain immediately; no-op if offline OR another tab is
  // the leader. Returning before the drain completes is fine — the
  // synthetic response carries the stable id.
  void tryDrain();
  return { id, bytes: file.size, ext, deduplicated: false };
}
