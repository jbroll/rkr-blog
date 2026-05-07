// Client-side image-op pipeline. Runs in the browser via HTMLCanvasElement
// 2d context — no native modules, no server round-trip.
//
// The pipeline mirrors the server-side sharp pipeline (lib/render.ts):
// crop / rotate / flip / resample, applied in click order. Each op
// produces a new canvas; the output of op N is the input of op N+1.
//
// Save-time bake (Phase 3) re-runs this same pipeline on the master
// original and uploads the final WebP to the server. WebP, not PNG,
// because camera photos compress ~10x better at q=0.95 with no
// perceptible loss. For live preview during edits we render at the
// original's full resolution when the source decodes; the browser
// scales the resulting <img> to fit the editor frame.

import { clampInt, computeResampleSize, normalizeRotation } from './canvas-math';

/** A sidecar op as it arrives from /admin/sidecar/:id/meta — the
 * server validates shape, so we accept the loose type here and narrow
 * per-op below. */
export type SidecarOp = { type: string; [k: string]: unknown };

export interface CanvasSource {
  /** The decoded source pixels — anything `drawImage` accepts. */
  drawable: CanvasImageSource;
  /** Source pixel width. (Browsers expose this via .naturalWidth on
   * HTMLImageElement and .width on ImageBitmap; passing it explicitly
   * keeps this module free of source-type narrowing.) */
  width: number;
  /** Source pixel height. */
  height: number;
}

/** Apply a list of ops, in order, returning the final canvas. The input
 * is left untouched. Throws on op shapes the renderer can't handle —
 * the server already validated shape at POST time, so this is a
 * defensive fallback rather than the primary line of defense. */
export function applyOps(source: CanvasSource, ops: readonly SidecarOp[]): HTMLCanvasElement {
  let canvas = drawSource(source);
  for (const op of ops) {
    canvas = applyOne(canvas, op);
  }
  return canvas;
}

function drawSource(source: CanvasSource): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('canvas: 2d context unavailable');
  ctx.drawImage(source.drawable, 0, 0);
  return out;
}

function applyOne(input: HTMLCanvasElement, op: SidecarOp): HTMLCanvasElement {
  switch (op.type) {
    case 'crop':
      return applyCrop(input, op);
    case 'rotate':
      return applyRotate(input, op);
    case 'flip':
      return applyFlip(input, op);
    case 'resample':
      return applyResample(input, op);
    default:
      // Unknown op — pass through. The server validates shapes; this
      // is a soft-fail so a future op type the client doesn't yet
      // know about doesn't crash the editor.
      return input;
  }
}

function applyCrop(input: HTMLCanvasElement, op: SidecarOp): HTMLCanvasElement {
  const x = clampInt(op.x, 0, input.width);
  const y = clampInt(op.y, 0, input.height);
  const w = clampInt(op.w, 1, input.width - x);
  const h = clampInt(op.h, 1, input.height - y);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('canvas: 2d context unavailable');
  ctx.drawImage(input, x, y, w, h, 0, 0, w, h);
  return out;
}

function applyRotate(input: HTMLCanvasElement, op: SidecarOp): HTMLCanvasElement {
  const norm = normalizeRotation(op.degrees);
  if (norm === null || norm === 0) return input;
  const swap = norm === 90 || norm === 270;
  const out = document.createElement('canvas');
  out.width = swap ? input.height : input.width;
  out.height = swap ? input.width : input.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('canvas: 2d context unavailable');
  // Translate to the centre, rotate, draw centred. Avoids fence-post
  // arithmetic per quadrant.
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((norm * Math.PI) / 180);
  ctx.drawImage(input, -input.width / 2, -input.height / 2);
  return out;
}

function applyFlip(input: HTMLCanvasElement, op: SidecarOp): HTMLCanvasElement {
  const axis = op.axis;
  if (axis !== 'horizontal' && axis !== 'vertical') return input;
  const out = document.createElement('canvas');
  out.width = input.width;
  out.height = input.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('canvas: 2d context unavailable');
  if (axis === 'horizontal') {
    ctx.translate(input.width, 0);
    ctx.scale(-1, 1);
  } else {
    ctx.translate(0, input.height);
    ctx.scale(1, -1);
  }
  ctx.drawImage(input, 0, 0);
  return out;
}

function applyResample(input: HTMLCanvasElement, op: SidecarOp): HTMLCanvasElement {
  const targetW = op.w !== undefined ? Number(op.w) : undefined;
  const targetH = op.h !== undefined ? Number(op.h) : undefined;
  const fit = typeof op.fit === 'string' ? op.fit : 'inside';
  const { width, height } = computeResampleSize(input.width, input.height, targetW, targetH, fit);
  if (width === input.width && height === input.height) return input;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('canvas: 2d context unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(input, 0, 0, width, height);
  return out;
}
