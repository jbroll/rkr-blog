// Image upload: POST /admin/upload online, queue to the outbox
// offline. Content-addressed: client + server compute the same
// sha256, so a savePost can reference the id before the upload
// drains.

import { computeContentId, extForMime } from '../lib/content-id.ts';
import { getState } from './online-state.ts';
import { writeBlob } from './opfs.ts';
import { append as outboxAppend } from './outbox.ts';
import { tryDrain } from './sync.ts';

export interface UploadResponse {
  id: string;
  bytes: number;
  ext: string;
  deduplicated: boolean;
}

export async function uploadImage(file: File): Promise<UploadResponse> {
  if (getState() !== 'offline') {
    try {
      return await postUpload(file);
    } catch {
      /* fall through to outbox queue */
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

async function queueUpload(file: File): Promise<UploadResponse> {
  const id = await computeContentId(file);
  const ext = extForMime(file.type);
  await writeBlob(`originals/${id}.${ext}`, file);
  await outboxAppend({
    op: 'upload',
    payload: { id, filename: file.name, mimeType: file.type }
  });
  void tryDrain();
  return { id, bytes: file.size, ext, deduplicated: false };
}
