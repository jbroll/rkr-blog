// Client-side ingest resize. Decode → EXIF-orientation-bake →
// long-edge clamp to MAX_DIM → WebP encode. Mirrors what the server
// does in `src/lib/originals.ts:ingestStream`, but moves the work
// to the browser so the bytes the client edits with are byte-
// identical to what the server stores. Without this, the client's
// OPFS holds raw upload bytes (e.g. a 4032×3024 phone JPEG) while
// the server resizes to 3200 long edge — sidecar ops emitted in
// the client's coord space don't translate to the server's base.
//
// Bytes are NOT bit-equivalent to the server's sharp output (browser
// + libwebp use different default encoder settings even at the same
// quality knob); we don't try to match. Content-id is the sha256 of
// whatever the client uploads, so the id always names the bytes on
// disk regardless of who encoded them.
//
// Decode failures (HEIC on non-Safari, animated GIF, SVG, TIFF in
// most browsers, corrupted files) return `null`; the caller falls
// back to the raw-upload path and the server handles ingest itself.

const MAX_LONG_EDGE = 3200;
const WEBP_QUALITY = 0.82;

export interface ClientResizeResult {
  blob: Blob;
  ext: 'webp';
  width: number;
  height: number;
}

/** Decode `file`, bake EXIF orientation, clamp long-edge to 3200,
 * re-encode as WebP. Returns null when the browser can't decode the
 * input (caller falls back to raw upload). Animated GIF and SVG fall
 * through to null too — `createImageBitmap` decodes only the first
 * frame, and re-encoding a vector image is the wrong operation. */
export async function resizeForUpload(file: File): Promise<ClientResizeResult | null> {
  // SVG + animated GIF must pass through; createImageBitmap would
  // decode them but the result would be a rasterised first-frame
  // snapshot, not what the user uploaded.
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') return null;
  // OffscreenCanvas + createImageBitmap are required. Older browsers
  // / private modes might lack one of them — fall through to raw.
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return null;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Unsupported format (HEIC outside Safari, corrupt, etc.). Caller
    // uploads the raw bytes and the server's ingest pipeline handles it.
    return null;
  }

  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const longEdge = Math.max(srcW, srcH);
  const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
  const outW = Math.max(1, Math.round(srcW * scale));
  const outH = Math.max(1, Math.round(srcH * scale));

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  /* v8 ignore next 4 -- 2d context is always available where OffscreenCanvas is */
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, outW, outH);
  bitmap.close();

  let blob: Blob;
  try {
    blob = await canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY });
  } catch {
    // Browser doesn't support WebP encoder (very rare in 2026).
    return null;
  }
  return { blob, ext: 'webp', width: outW, height: outH };
}
