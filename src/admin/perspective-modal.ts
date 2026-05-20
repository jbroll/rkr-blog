// Perspective rectify modal: custom UI (no third-party lib). Load the
// local post-ops canvas as the stage, place 4 absolutely-positioned
// handles over it (initially at the four image corners), let the user
// drag each, and on Save commit a perspective op whose corners are in
// current-canvas (post-prior-ops) space. The canvas pipeline's
// applyPerspective then runs a WebGL homography to rectify.

import { computeHomography, type Point, perspectiveOutputSize } from '../lib/canvas-math.ts';
import { type LocalEditState, localMutate } from '../lib/image-edit-ops.ts';
import type { SidecarOp } from '../lib/sidecar-types.ts';
import { getPipelineCache, loadOriginal, webpOrJpeg } from './canvas-loaders';
import { openModal } from './dialog-focus';
import { $, setStatus } from './dom';

interface PerspSession {
  /** Canvas-pixel coords of the four handles, in tl/tr/br/bl order. */
  corners: [Point, Point, Point, Point];
  /** Source canvas dimensions in pixel space. */
  canvasW: number;
  canvasH: number;
  /** Cleanup hook; revokes the stage Blob URL and removes handles. */
  dispose: () => void;
}

let activePersp: PerspSession | null = null;

export async function openPerspective(
  id: string,
  s: LocalEditState,
  onSaved: () => void
): Promise<void> {
  const dialog = $<HTMLDialogElement>('rkr-persp-modal');
  const stage = $<HTMLDivElement>('rkr-persp-stage');
  const stageImg = $<HTMLImageElement>('rkr-persp-img');
  const svg = document.getElementById('rkr-persp-svg') as unknown as SVGSVGElement | null;
  const status = $<HTMLSpanElement>('rkr-persp-status');
  const cancelBtn = $<HTMLButtonElement>('rkr-persp-cancel');
  const saveBtn = $<HTMLButtonElement>('rkr-persp-save');
  if (!svg) {
    setStatus('perspective: SVG overlay missing');
    return;
  }
  const svgEl: SVGSVGElement = svg;

  // Build the post-ops canvas (current-state baseline for perspective).
  let canvas: HTMLCanvasElement;
  try {
    const original = await loadOriginal(id);
    canvas = getPipelineCache(id).apply(
      {
        drawable: original,
        width: original.naturalWidth,
        height: original.naturalHeight
      },
      s.ops
    );
  } catch (err) {
    setStatus(`perspective: ${(err as Error).message}`);
    return;
  }
  let blob: Blob;
  try {
    blob = await webpOrJpeg(canvas);
  } catch (err) {
    setStatus(`perspective: ${(err as Error).message}`);
    return;
  }
  const stageUrl = URL.createObjectURL(blob);

  // Initial handle positions: the four image corners in canvas pixel
  // space. Drag-to-reposition runs in stage pixel space; we convert at
  // commit time via the displayed image's bounding rect.
  const corners: [Point, Point, Point, Point] = [
    [0, 0],
    [canvas.width, 0],
    [canvas.width, canvas.height],
    [0, canvas.height]
  ];

  const handles: HTMLDivElement[] = [];
  for (let i = 0; i < 4; i++) {
    const h = document.createElement('div');
    h.className = 'rkr-persp-handle';
    h.dataset.idx = String(i);
    h.setAttribute('aria-label', `Corner ${i + 1}`);
    stage.appendChild(h);
    handles.push(h);
  }

  function imgRect(): DOMRect {
    return stageImg.getBoundingClientRect();
  }
  function stageRect(): DOMRect {
    return stage.getBoundingClientRect();
  }

  /** Map canvas-pixel coords → stage-pixel coords (for handle position
   * + svg). The displayed image is letterboxed inside the stage. */
  function canvasToStage(p: Point): [number, number] {
    const ir = imgRect();
    const sr = stageRect();
    const sx = p[0] * (ir.width / canvas.width) + (ir.left - sr.left);
    const sy = p[1] * (ir.height / canvas.height) + (ir.top - sr.top);
    return [sx, sy];
  }
  /** Map stage-pixel coords → canvas-pixel coords (commit direction). */
  function stageToCanvas(sx: number, sy: number): Point {
    const ir = imgRect();
    const sr = stageRect();
    const cx = ((sx - (ir.left - sr.left)) * canvas.width) / ir.width;
    const cy = ((sy - (ir.top - sr.top)) * canvas.height) / ir.height;
    // Clamp to canvas bounds; the user may drag outside.
    return [Math.max(0, Math.min(canvas.width, cx)), Math.max(0, Math.min(canvas.height, cy))];
  }

  function repaint(): void {
    for (let i = 0; i < 4; i++) {
      const c = corners[i] as Point;
      const [sx, sy] = canvasToStage(c);
      const h = handles[i] as HTMLDivElement;
      h.style.left = `${sx}px`;
      h.style.top = `${sy}px`;
    }
    // SVG quad: connect handles in order with a closed polygon.
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
    const ns = 'http://www.w3.org/2000/svg';
    const poly = document.createElementNS(ns, 'polygon');
    const points = corners
      .map((c) => {
        const [sx, sy] = canvasToStage(c);
        return `${sx},${sy}`;
      })
      .join(' ');
    poly.setAttribute('points', points);
    poly.setAttribute('fill', 'rgba(64, 128, 255, 0.15)');
    poly.setAttribute('stroke', 'rgba(64, 128, 255, 0.9)');
    poly.setAttribute('stroke-width', '2');
    svgEl.appendChild(poly);
  }

  // Pointer Events for unified mouse / touch / pen.
  function onPointerDown(ev: PointerEvent): void {
    const target = ev.currentTarget as HTMLDivElement;
    const idx = Number(target.dataset.idx);
    if (!Number.isInteger(idx)) return;
    target.setPointerCapture(ev.pointerId);
    ev.preventDefault();

    function onMove(mv: PointerEvent): void {
      const sr = stageRect();
      corners[idx] = stageToCanvas(mv.clientX - sr.left, mv.clientY - sr.top);
      repaint();
    }
    function onUp(_up: PointerEvent): void {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    }
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }
  for (const h of handles) {
    h.addEventListener('pointerdown', onPointerDown);
  }

  function dispose(): void {
    URL.revokeObjectURL(stageUrl);
    for (const h of handles) h.remove();
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
  }
  activePersp = { corners, canvasW: canvas.width, canvasH: canvas.height, dispose };

  // Assign onload BEFORE setting src so a cache hit doesn't fire load
  // before the handler is attached. Fallback below handles that case.
  stageImg.onload = (): void => {
    repaint();
    status.textContent = `${canvas.width}×${canvas.height} current`;
  };
  stageImg.src = stageUrl;
  // Fallback: if the blob URL resolved synchronously from cache, the
  // load event already fired before our handler was set.
  if (stageImg.complete && stageImg.naturalWidth > 0) {
    stageImg.onload(new Event('load'));
  }

  // Refresh on resize (browser zoom, viewport changes).
  const onResize = (): void => repaint();
  window.addEventListener('resize', onResize);

  saveBtn.onclick = (): void => {
    // Validate the quad is non-degenerate (no three colinear points)
    // before committing: computeHomography returns null on a singular
    // linear system, applyPerspective would then no-op, and the user
    // would see no preview update with no explanation. Catch it here
    // and tell them why.
    const { w: outW, h: outH } = perspectiveOutputSize(corners);
    const dst: [Point, Point, Point, Point] = [
      [0, 0],
      [outW, 0],
      [outW, outH],
      [0, outH]
    ];
    if (!computeHomography(corners, dst)) {
      status.textContent = 'corners are degenerate (three colinear points?); adjust them';
      return;
    }
    const op: SidecarOp = {
      type: 'perspective',
      corners: corners.map((c) => [Math.round(c[0]), Math.round(c[1])])
    };
    localMutate(s, (ops) => [...ops, op]);
    closePerspective();
    window.removeEventListener('resize', onResize);
    onSaved();
  };
  cancelBtn.onclick = (): void => {
    closePerspective();
    window.removeEventListener('resize', onResize);
  };
  dialog.addEventListener(
    'close',
    () => {
      closePerspective();
      window.removeEventListener('resize', onResize);
    },
    { once: true }
  );
  openModal(dialog);
}

function closePerspective(): void {
  const dialog = $<HTMLDialogElement>('rkr-persp-modal');
  if (activePersp) {
    activePersp.dispose();
    activePersp = null;
  }
  if (dialog.open) dialog.close();
}
