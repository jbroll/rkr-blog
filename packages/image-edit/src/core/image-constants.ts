// Shared image-pipeline constants. Both render.ts and originals.ts use
// these; placing them here avoids the import cycle they'd otherwise
// form (each had a private copy of FORMAT_TO_EXT to dodge it).

/** Maximum pixel count any sharp pipeline will decode for downstream
 * reads (render, bake-upload, sidecar validation). Anti-DoS: caps
 * memory and CPU on a single render. 50 Mpx is comfortably above any
 * realistic camera sensor *after* ingest-time downsample lands its
 * default 3200 px long-edge clamp. */
export const SHARP_PIXEL_LIMIT = 50_000_000;

/** Higher ceiling used only by the ingest path, which accepts large
 * camera/HEIC uploads and immediately resizes them down (see
 * lib/ingest-resize.ts). 200 Mpx accommodates a 14000×14000 input —
 * beyond any consumer camera — while still rejecting genuine
 * decompression-bomb payloads pre-decode. The resulting on-disk
 * bytes always fit under SHARP_PIXEL_LIMIT. */
export const SHARP_INGEST_PIXEL_LIMIT = 200_000_000;

/** Map Sharp/libvips format names to on-disk file extensions. SVG is
 * passed through as-is by the ingest resize step (no raster pixels to
 * resize); every other entry corresponds to a format the resize step
 * either re-encodes to WebP or passes through (animated GIF). */
export const FORMAT_TO_EXT: Record<string, string | undefined> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
  tiff: 'tiff',
  heif: 'heif',
  svg: 'svg'
};

/** Defaults applied to ingestStream when the caller omits resize
 * overrides. See lib/ingest-resize.ts for the meaning of each knob. */
export const DEFAULT_INGEST_RESIZE = {
  maxDim: 3200,
  scalePct: 100,
  webpQuality: 82
} as const;

/** Caller-side validation bounds for resize knobs. Out-of-range
 * values from route bodies snap to these before reaching the helper;
 * the helper also clamps defensively. */
export const INGEST_RESIZE_BOUNDS = {
  maxDim: { min: 64, max: 8000 },
  scalePct: { min: 10, max: 100 },
  webpQuality: { min: 1, max: 100 }
} as const;
