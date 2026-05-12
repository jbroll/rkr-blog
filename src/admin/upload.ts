// Image upload: local-first + client-side ingest resize.
//
// Pipeline per file:
//   1. resizeForUpload (browser canvas): decode → EXIF bake →
//      long-edge clamp to 3200 → WebP encode. Returns null if the
//      format isn't browser-decodable (HEIC on non-Safari, etc.).
//   2. sha256 the resulting blob → content-id.
//   3. Write to OPFS originals/<id>.<ext> + queue an `upload`
//      outbox entry. tryDrain runs the server POST in the
//      background.
//
// The id is sha256 of the bytes the client uploads, so the server's
// content-addressed dedup path sees consistent ids: a re-upload of
// the same source through the same client environment is a no-op
// server-side.
//
// When resizeForUpload returns null (HEIC, SVG, animated GIF, decode
// failure), the raw file bytes ship instead. The server's
// ingest-resize handles those — coord-divergence is still possible
// for that path but the trigger is narrow (non-Safari + HEIC source
// + offline edit). Tracked in DEFERRED.md.

import { computeContentId, extForMime } from '../lib/content-id.ts';
import { resizeForUpload } from './ingest-resize-client.ts';
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
  const resized = await resizeForUpload(file);
  const blob: Blob = resized?.blob ?? file;
  const ext = resized?.ext ?? extForMime(file.type);
  const mimeType = resized ? 'image/webp' : file.type;
  // Re-derive the filename for the upload entry. Keep the user's
  // original stem so server logs / status messages reference what
  // they uploaded, but swap the extension to match the bytes we're
  // actually shipping so the server's `extForMime` lookup is happy.
  const filename = resized ? swapExt(file.name, 'webp') : file.name;

  const id = await computeContentId(blob);
  await writeBlob(`originals/${id}.${ext}`, blob);
  await outboxAppend({
    op: 'upload',
    payload: { id, filename, mimeType }
  });
  void tryDrain();
  return { id, bytes: blob.size, ext, deduplicated: false };
}

function swapExt(name: string, newExt: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}.${newExt}` : `${name}.${newExt}`;
}
