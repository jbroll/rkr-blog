// Isomorphic image-edit core: op types, validation, ops-state mutators,
// geometry/colour math, shared constants, and canonical JSON.
// Consumed by the blog server (sharp render pipeline), the blog admin SPA,
// and apps/image-pwa — no DOM, no node-only APIs.
//
// Named re-exports, not `export *`: this is the package's public entry point
// (package.json "."), so a leaf adding an export must not widen the API by
// accident.

export { type CanonicalValue, canonicalJson } from './canonical-json.ts';
export {
  clampInt,
  computeHomography,
  computeResampleSize,
  invertMatrix3,
  normalizeRotation,
  opsEqual,
  type Point,
  perspectiveOutputSize,
  simplifyOps
} from './canvas-math.ts';
export {
  DEFAULT_INGEST_RESIZE,
  FORMAT_TO_EXT,
  INGEST_RESIZE_BOUNDS,
  SHARP_INGEST_PIXEL_LIMIT,
  SHARP_PIXEL_LIMIT
} from './image-constants.ts';
export {
  appendFlip,
  appendRotate,
  describeOp,
  isDirty,
  type LocalEditState,
  localDeleteAt,
  localMutate,
  localRedo,
  localUndo
} from './image-edit-ops.ts';
export { validateOps } from './ops-validation.ts';
export { inscribedRect } from './rotation.ts';
export type { Sidecar, SidecarOp, SidecarResizeRecord } from './sidecar-types.ts';
