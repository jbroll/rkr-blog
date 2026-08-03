// The facts a renderer needs about one image, gathered before any
// markup is emitted. Server and client build this map their own way
// (image-map-fs.ts / admin/image-map-opfs.ts); the renderer is pure
// string work either side of it.

import type { Sidecar } from '@rkr/image-edit';

export interface ImageSource {
  sidecar: Sidecar;
  /** Pixel dimensions of the image the renderer will actually serve. */
  width: number;
  height: number;
  urlFor(width: number, format: string, quality: number): string;
}

/** Keyed by the id as written in the post, lowercased — prefix
 * resolution happens while the map is built, where the full sidecar
 * list is in hand. A missing key means "unresolvable". */
export type ImageMap = Map<string, ImageSource>;
