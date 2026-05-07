// Shared image-pipeline constants. Both render.ts and originals.ts use
// these; placing them here avoids the import cycle they'd otherwise
// form (each had a private copy of FORMAT_TO_EXT to dodge it).

/** Maximum pixel count any sharp pipeline will decode. Anti-DoS: caps
 * memory and CPU on a single render. 50 Mpx is comfortably above any
 * realistic camera sensor. */
export const SHARP_PIXEL_LIMIT = 50_000_000;

/** Map Sharp/libvips format names to on-disk file extensions. */
export const FORMAT_TO_EXT: Record<string, string | undefined> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
  tiff: 'tiff',
  heif: 'heif'
};
