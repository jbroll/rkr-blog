// Sidecar type declarations, separated from lib/sidecar.ts so the
// browser bundle (admin/canvas.ts → admin/main.ts) can import them
// without dragging in node:fs / node:crypto / node:path. lib/sidecar.ts
// re-exports these for server-side compatibility.

export interface SidecarSource {
  kind: string;
  fetched?: string;
  originalName?: string | null;
  // Provider-specific fields (fileId, etc.) are allowed but unenumerated.
  [k: string]: unknown;
}

export interface SidecarMetadata {
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

export interface SidecarOutput {
  format: string;
  quality?: number;
  [k: string]: unknown;
}

export interface SidecarVariant {
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
