// Compute the content-addressed id (sha256 hex) for a Blob / File /
// ArrayBuffer of image bytes. The server uses the same digest in
// src/lib/originals.ts:ingestStream — keeping the algorithms aligned
// is what makes "client computes id offline → drain → server returns
// the same id" work without remapping (spec.md §4 + spec-offline.md
// §4 — content-addressed identity is stable client + server).
//
// SubtleCrypto.digest is universal in Node 22+ (globalThis.crypto)
// and every browser that has OPFS, so this module is dual-target
// without polyfills.

/** sha256 hex of the input bytes. */
export async function computeContentId(input: Blob): Promise<string> {
  const buf = await input.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Map a MIME type to a file extension used in OPFS paths
 * (originals/<id>.<ext>). Mirrors src/lib/image-constants.ts's
 * FORMAT_TO_EXT but keyed by MIME instead of sharp format. Falls
 * back to 'bin' for unknown types — the server will normalize on
 * upload via sharp.metadata, so this only matters until the
 * outbox drain replaces it with the canonical value. */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heic'
};

export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime.toLowerCase()] ?? 'bin';
}
