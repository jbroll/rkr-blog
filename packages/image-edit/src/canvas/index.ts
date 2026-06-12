// Browser-only image-edit surface: the incremental pixel pipeline, pure encode
// helpers, and the crop / perspective modals (which take an injected decoded
// source + pipeline + status sink, so they carry no host-app coupling).
// Consumed by the blog admin SPA and apps/image-pwa. Depends on the core
// export (@rkr/image-edit) for op types + geometry math.
export { type CanvasSource, PipelineCache } from './canvas.ts';
export { openCropper } from './cropper-modal.ts';
export { $, openModal, type StatusFn } from './dom-helpers.ts';
export { canvasToBlob, supportsWebP, webpOrJpeg } from './encode.ts';
export { type ClientResizeResult, resizeForUpload } from './ingest-resize.ts';
export { openPerspective } from './perspective-modal.ts';
