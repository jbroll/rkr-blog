// Image upload: local-first. Compute the content-addressed id +
// write the blob to OPFS originals/ + queue a `upload` outbox entry,
// then return immediately. tryDrain kicks the drain loop so the
// server POST happens in the background — online users see the
// figure insert instantly (no spinner-on-network wait); offline
// users get the same flow with the drain queued until reconnect.
//
// The id is sha256 of the bytes, computed identically on client
// and server, so a savePost can reference the id before the
// upload's POST completes — the server's content-addressed dedup
// path makes a later double-upload a no-op.

import { computeContentId, extForMime } from '../lib/content-id.ts';
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
