// Full-parity toolbar: rotate / tilt / flip / crop / perspective / undo / redo
// + a format-picker download. Each control drives the in-memory edit state or
// opens a package modal (which mutates the same state and triggers onSaved).

import {
  type CanvasSource,
  openCropper,
  openPerspective,
  type PipelineCache
} from '@rkr/image-edit/canvas';
import { downloadCanvas, type OutFormat } from './download.ts';
import {
  applyFlip,
  applyRotate,
  canRedo,
  canUndo,
  type MemoryState,
  redo,
  undo
} from './memory-edit-state.ts';

export interface ToolbarCtx {
  mem: MemoryState;
  pipeline: PipelineCache;
  /** Decoded ORIGINAL image; the pipeline applies ops to it. */
  source: CanvasSource;
  inputName: string;
  /** Re-render the preview from the current ops. */
  renderPreview: () => void;
  /** Optional status sink (also passed to the modals). */
  onStatus?: (msg: string, isError?: boolean) => void;
}

const TOOLBAR_HTML = `
  <button type="button" data-act="rotL" title="Rotate left">⟲ 90°</button>
  <button type="button" data-act="rotR" title="Rotate right">⟳ 90°</button>
  <label class="tilt">tilt
    <input data-act="tilt" type="range" min="-15" max="15" step="0.5" value="0" />
  </label>
  <button type="button" data-act="flipH" title="Flip horizontal">⇆</button>
  <button type="button" data-act="flipV" title="Flip vertical">⇅</button>
  <button type="button" data-act="crop">Crop</button>
  <button type="button" data-act="persp">Perspective</button>
  <button type="button" data-act="undo">Undo</button>
  <button type="button" data-act="redo">Redo</button>
  <span class="spacer"></span>
  <select data-act="fmt" title="Download format">
    <option value="png">PNG</option>
    <option value="webp" selected>WebP</option>
    <option value="jpeg">JPEG</option>
  </select>
  <label class="quality">q
    <input data-act="quality" type="range" min="0.3" max="1" step="0.05" value="0.9" />
  </label>
  <button type="button" data-act="download">Download</button>
`;

export function mountToolbar(root: HTMLElement, ctx: ToolbarCtx): void {
  root.innerHTML = TOOLBAR_HTML;
  const onStatus = ctx.onStatus ?? (() => {});
  const sel = <T extends HTMLElement>(act: string): T =>
    root.querySelector<T>(`[data-act="${act}"]`) as T;

  const refresh = (): void => {
    sel<HTMLButtonElement>('undo').disabled = !canUndo(ctx.mem);
    sel<HTMLButtonElement>('redo').disabled = !canRedo(ctx.mem);
    ctx.renderPreview();
  };

  // Tilt slider applies its delta since the last value (appendRotate merges
  // adjacent rotations, so successive deltas accumulate into one rotate op).
  let prevTilt = 0;
  sel<HTMLInputElement>('tilt').addEventListener('input', (e) => {
    const val = Number((e.target as HTMLInputElement).value);
    applyRotate(ctx.mem, val - prevTilt);
    prevTilt = val;
  });

  root.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    switch (act) {
      case 'rotL':
        applyRotate(ctx.mem, -90);
        break;
      case 'rotR':
        applyRotate(ctx.mem, 90);
        break;
      case 'flipH':
        applyFlip(ctx.mem, 'horizontal');
        break;
      case 'flipV':
        applyFlip(ctx.mem, 'vertical');
        break;
      case 'undo':
        undo(ctx.mem);
        break;
      case 'redo':
        redo(ctx.mem);
        break;
      case 'crop':
        void openCropper(ctx.source, ctx.pipeline, ctx.mem.state, refresh, onStatus);
        return;
      case 'persp':
        void openPerspective(ctx.source, ctx.pipeline, ctx.mem.state, refresh, onStatus);
        return;
      case 'download': {
        const canvas = ctx.pipeline.apply(ctx.source, ctx.mem.state.ops);
        const fmt = sel<HTMLSelectElement>('fmt').value as OutFormat;
        const quality = Number(sel<HTMLInputElement>('quality').value);
        void downloadCanvas(canvas, ctx.inputName, fmt, quality);
        return;
      }
      default:
        return;
    }
    refresh();
  });

  refresh();
}
