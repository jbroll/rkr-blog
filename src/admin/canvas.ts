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

// SidecarOp lives in lib/sidecar-types.ts (a pure type module — no
// node:fs / node:crypto, safe for the browser bundle). Callers import
// from there directly; canvas.ts uses it internally.
import type { SidecarOp } from '../lib/sidecar-types.ts';
import {
  clampInt,
  computeHomography,
  computeResampleSize,
  invertMatrix3,
  normalizeRotation,
  opsEqual,
  type Point,
  perspectiveOutputSize,
  simplifyOps
} from './canvas-math';

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

/** Per-image incremental pipeline cache. Holds the last simplified op
 * list and its result canvas. On a subsequent apply with the simplified
 * new ops being the previous simplified list + exactly one appended op,
 * applies just that op to the cached canvas — the "only execute the
 * last step on each change" fast path. Anything else misses the cache
 * and re-executes from source.
 *
 * Operating on simplified ops means click `rotate 90` then `rotate
 * -90` collapses to nothing: the user-visible result reverts to source
 * and we don't run sharp on a no-op chain. */
export class PipelineCache {
  private lastResult: HTMLCanvasElement | null = null;
  private lastSimplified: SidecarOp[] = [];

  apply(source: CanvasSource, ops: readonly SidecarOp[]): HTMLCanvasElement {
    const simplified = simplifyOps(ops);

    // Cache hit: new simplified is previous + exactly one appended op.
    if (
      this.lastResult !== null &&
      simplified.length === this.lastSimplified.length + 1 &&
      this.lastSimplified.every((op, i) => {
        const next = simplified[i];
        return next !== undefined && opsEqual(op, next);
      })
    ) {
      const newOp = simplified[simplified.length - 1];
      if (newOp) {
        const next = applyOne(this.lastResult, newOp);
        this.lastResult = next;
        this.lastSimplified = [...simplified];
        return next;
      }
    }

    // Cache miss: re-execute the simplified chain from source.
    let canvas = drawSource(source);
    for (const op of simplified) {
      canvas = applyOne(canvas, op);
    }
    this.lastResult = canvas;
    this.lastSimplified = [...simplified];
    return canvas;
  }

  /** Drop the cache. Call when the source image (the master) has been
   * replaced — e.g. the user navigates between different images. */
  invalidate(): void {
    this.lastResult = null;
    this.lastSimplified = [];
  }
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
    case 'perspective':
      return applyPerspective(input, op);
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

// ---- perspective rectify ---------------------------------------------
// Canvas2D's setTransform is affine — no projective component — so we
// can't do perspective with the 2D context alone. WebGL is the right
// tool: pass the source canvas as a texture, draw a fullscreen quad
// at the rectified output size, and let a fragment shader sample the
// source via the inverse homography per pixel.

function parsePerspectiveCorners(op: SidecarOp): [Point, Point, Point, Point] | null {
  const c = op.corners;
  if (!Array.isArray(c) || c.length !== 4) return null;
  const out: Point[] = [];
  for (const p of c) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push([x, y]);
  }
  return out as [Point, Point, Point, Point];
}

function applyPerspective(input: HTMLCanvasElement, op: SidecarOp): HTMLCanvasElement {
  const corners = parsePerspectiveCorners(op);
  if (!corners) {
    console.warn('applyPerspective: malformed corners, op skipped', op);
    return input;
  }
  const { w: outW, h: outH } = perspectiveOutputSize(corners);
  // H maps source corners → output corners (0,0)-(outW,outH). Sampling
  // wants the inverse: for each output pixel, where in the source
  // texture does it come from?
  const dst: [Point, Point, Point, Point] = [
    [0, 0],
    [outW, 0],
    [outW, outH],
    [0, outH]
  ];
  const H = computeHomography(corners, dst);
  if (!H) {
    console.warn('applyPerspective: degenerate quadrilateral, op skipped', corners);
    return input;
  }
  const Hinv = invertMatrix3(H);
  if (!Hinv) {
    console.warn('applyPerspective: singular homography, op skipped');
    return input;
  }

  // GL canvas drives the rasterization; we copy the result back to a
  // 2D canvas so downstream ops in the chain (which expect HTMLCanvasElement
  // sources) can keep using getContext('2d'). Browsers cap concurrent
  // WebGL contexts at 8-16; without explicit teardown after each call,
  // heavy editing exhausts the cap and getContext('webgl') starts
  // returning null. We delete the program/buffer/texture and force
  // context loss before returning.
  const gl = createWebglCanvas(outW, outH);
  if (!gl) {
    console.warn('applyPerspective: WebGL unavailable, op skipped');
    // WebGL unavailable in this browser. Fall back to passing the
    // input through unchanged — the server's bake will be wrong, but
    // the editor doesn't crash. (The perspective button is disabled
    // at mount time when WebGL is unavailable; this branch is the
    // belt-and-suspenders path for a context that vanishes between
    // probe and use.)
    return input;
  }

  try {
    drawPerspective(gl, input, Hinv, outW, outH);

    // Snapshot to a 2D canvas so the downstream pipeline (and toBlob)
    // can consume it without WebGL knowledge.
    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('canvas: 2d context unavailable');
    ctx.drawImage(gl.canvas, 0, 0);
    return out;
  } finally {
    disposeGlContext(gl);
  }
}

function disposeGlContext(ctx: GlContext): void {
  const { gl, program, texture, positionBuf } = ctx;
  gl.deleteTexture(texture);
  gl.deleteBuffer(positionBuf);
  gl.deleteProgram(program);
  // Force the underlying GPU context to release. Without this, the
  // browser's per-page WebGL-context cap fills up after a handful
  // of perspective edits and subsequent createWebglCanvas calls
  // return null — silently degrading every later perspective op.
  const ext = gl.getExtension('WEBGL_lose_context');
  if (ext) ext.loseContext();
}

interface GlContext {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
  positionBuf: WebGLBuffer;
  uHinvLoc: WebGLUniformLocation;
  uTexSizeLoc: WebGLUniformLocation;
}

// We flip Y in the vertex shader so that v_dst follows the canvas
// (Y-down) convention: v_dst.y=0 at the visual top of the output
// canvas, =1 at the bottom. The texture is uploaded WITHOUT
// UNPACK_FLIP_Y_WEBGL so its UV maps the same way (UV.y=0 at top).
// All coordinate math in the fragment shader is then plain
// canvas-pixel space; no extra flips.
const VERTEX_SRC = `
attribute vec2 a_pos;
varying vec2 v_dst;
void main() {
  v_dst = (a_pos + 1.0) * 0.5; // [-1,1] → [0,1]
  gl_Position = vec4(a_pos.x, -a_pos.y, 0.0, 1.0);
}`;

// For each output pixel: compute the inverse-homographied source pixel,
// divide by w, sample. Pixels that map outside the source bounds are
// transparent (the user's quadrilateral may extend past source edges).
const FRAGMENT_SRC = `
precision mediump float;
varying vec2 v_dst;
uniform sampler2D u_src;
uniform vec2 u_outSize;
uniform vec2 u_srcSize;
uniform mat3 u_hinv;
void main() {
  vec2 p = v_dst * u_outSize;
  vec3 src = u_hinv * vec3(p, 1.0);
  vec2 srcPx = src.xy / src.z;
  vec2 srcUv = srcPx / u_srcSize;
  if (srcUv.x < 0.0 || srcUv.x > 1.0 || srcUv.y < 0.0 || srcUv.y > 1.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  gl_FragColor = texture2D(u_src, srcUv);
}`;

function createWebglCanvas(width: number, height: number): GlContext | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl', { premultipliedAlpha: false });
  if (!gl) return null;

  const program = compileProgram(gl, VERTEX_SRC, FRAGMENT_SRC);
  if (!program) return null;
  gl.useProgram(program);

  // Fullscreen triangle pair covering [-1,1] × [-1,1].
  const positions = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
  const positionBuf = gl.createBuffer();
  if (!positionBuf) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuf);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  const aPosLoc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(aPosLoc);
  gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const uHinvLoc = gl.getUniformLocation(program, 'u_hinv');
  const uTexSizeLoc = gl.getUniformLocation(program, 'u_srcSize');
  const uOutSizeLoc = gl.getUniformLocation(program, 'u_outSize');
  if (!uHinvLoc || !uTexSizeLoc || !uOutSizeLoc) return null;
  gl.uniform2f(uOutSizeLoc, width, height);

  return { canvas, gl, program, texture, positionBuf, uHinvLoc, uTexSizeLoc };
}

function drawPerspective(
  ctx: GlContext,
  source: HTMLCanvasElement,
  Hinv: readonly number[],
  outW: number,
  outH: number
): void {
  const { gl, texture, uHinvLoc, uTexSizeLoc } = ctx;
  gl.viewport(0, 0, outW, outH);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.uniform2f(uTexSizeLoc, source.width, source.height);

  // mat3 uniforms in WebGL are column-major. Hinv is row-major; transpose.
  const colMajor = new Float32Array([
    Hinv[0] as number,
    Hinv[3] as number,
    Hinv[6] as number,
    Hinv[1] as number,
    Hinv[4] as number,
    Hinv[7] as number,
    Hinv[2] as number,
    Hinv[5] as number,
    Hinv[8] as number
  ]);
  gl.uniformMatrix3fv(uHinvLoc, false, colMajor);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function compileProgram(
  gl: WebGLRenderingContext,
  vertSrc: string,
  fragSrc: string
): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}
