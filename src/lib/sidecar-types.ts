// Sidecar type declarations, separated from lib/sidecar.ts so the
// browser bundle (admin/canvas.ts → admin/main.ts) can import them
// without dragging in node:fs / node:crypto / node:path.

/** Audit record of the ingest-time resize/re-encode step that ran on
 * the upload bytes (see lib/ingest-resize.ts). Present on every
 * sidecar written after that feature shipped; older sidecars lack it
 * and consumers should treat absence as "untouched original". */
export interface SidecarResizeRecord {
  /** True only when actual pixel shrink occurred. */
  applied: boolean;
  reason: 'gif-animated' | 'svg' | 'no-shrink-needed' | 'resized';
  maxDim: number;
  scalePct: number;
  webpQuality: number;
  encoding: 'lossy' | 'lossless' | 'passthrough';
}

interface SidecarSource {
  kind: string;
  fetched?: string;
  originalName?: string | null;
  /** SHA256 of the post-resize bytes on disk. Differs from
   * Sidecar.original (the upload-bytes hash / id) whenever the
   * ingest resize step rewrote bytes. Absent on sidecars from
   * before that feature. */
  storedHash?: string;
  /** Pre-resize upload metadata, captured before the ingest resize
   * runs so we can surface "original was 4032×3024 HEIC" in the
   * editor even though the bytes on disk are now post-resize WebP. */
  uploadFormat?: string;
  uploadWidth?: number;
  uploadHeight?: number;
  uploadBytes?: number;
  /** Knob values applied during ingest resize. Null on dedupe hits
   * that reused an existing sidecar with no resize record. */
  resize?: SidecarResizeRecord;
  // Provider-specific fields (fileId, etc.) are allowed but unenumerated.
  [k: string]: unknown;
}

interface SidecarMetadata {
  width?: number;
  height?: number;
  format?: string;
  exif?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface SidecarOp {
  type: string;
  [k: string]: unknown;
}

interface SidecarOutput {
  format: string;
  quality?: number;
  [k: string]: unknown;
}

interface SidecarVariant {
  w?: number;
  h?: number;
  fit?: string;
  [k: string]: unknown;
}

export interface Sidecar {
  version: 1;
  original: string;
  source: SidecarSource;
  metadata: SidecarMetadata;
  ops: SidecarOp[];
  /** Ops popped via undo, in pop order (i.e. the last entry is the
   * one redo would re-apply first). Persisted with the sidecar so
   * undo/redo survives reload + cross-session. Optional for backward
   * compatibility with sidecars written before this field existed.
   * Adding a new op clears this stack — the standard linear-undo
   * invariant. */
  redoStack?: SidecarOp[];
  outputs: SidecarOutput[];
  variants: SidecarVariant[];
}
