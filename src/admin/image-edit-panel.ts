// Image-edit pipeline UI: the crop / rotate / flip / perspective /
// resample / undo / redo / save / reset buttons + the ordered edit-
// steps list. Scoped to whichever image the host has activated; the
// host owns the active-image state and calls `activateForId` after each
// change, and `onPreview` tells it where the latest result lives.

import type { SidecarOp } from '@rkr/image-edit';

import {
  appendFlip,
  appendRotate,
  describeOp,
  isDirty,
  type LocalEditState,
  localDeleteAt,
  localMutate,
  localRedo,
  localUndo
} from '@rkr/image-edit';
import {
  type CanvasSource,
  openCropper,
  openPerspective,
  type PipelineCache
} from '@rkr/image-edit/canvas';
import { setStatus } from './dom.ts';
import type { ImageEditPipeline } from './image-edit.ts';

interface ImageEditPanelButtons {
  crop: HTMLButtonElement;
  rotateL: HTMLButtonElement;
  rotateR: HTMLButtonElement;
  flipH: HTMLButtonElement;
  flipV: HTMLButtonElement;
  perspective: HTMLButtonElement;
  undo: HTMLButtonElement;
  redo: HTMLButtonElement;
  reset: HTMLButtonElement;
  /** The legacy editor's in-panel Save; the unified dialog applies
   * through `save()` from its own footer instead. */
  save?: HTMLButtonElement;
  resample: HTMLButtonElement;
  tilt: HTMLButtonElement;
}

export interface ImageEditPanelDeps {
  /** A new preview URL for `id`: after each edit, on activate, and
   * after an applied save. */
  onPreview(id: string, url: string): void;
  section: HTMLDivElement;
  buttons: ImageEditPanelButtons;
  resampleInput: HTMLInputElement;
  tiltSlider: HTMLInputElement;
  tiltInput: HTMLInputElement;
  editsList: HTMLOListElement;
  /** Read the currently-active image id (null when no cell is
   * selected). Called at click time so the latest selection is used. */
  activeImageId: () => string | null;
  /** `imageEditPipeline` in the app; tests pass fakes. */
  pipeline: ImageEditPipeline;
}

export interface ImageEditPanel {
  /** Fetch local state for `id`, render the edits list, repaint the
   * editor preview, and reveal the panel. `stillCurrent` is checked
   * after the async fetch resolves; if it returns false the paint is
   * skipped (selection moved on while we were waiting). */
  activateForId(id: string, stillCurrent: () => boolean): void;
  /** Hide the panel and clear its contents. */
  deactivate(): void;
  /** Commit the active image's edits. Resolves false when there was
   * nothing to apply; rejects when the commit fails. */
  save(): Promise<boolean>;
  /** Drop the active image's unapplied edits. */
  discard(): void;
}

export function wireImageEditPanel(deps: ImageEditPanelDeps): ImageEditPanel {
  const {
    onPreview,
    section,
    buttons,
    resampleInput,
    tiltSlider,
    tiltInput,
    editsList,
    activeImageId
  } = deps;
  const pipeline = deps.pipeline;
  // Empty-state hint shown in the cell dialog when no cell is active.
  // openCellDialog can fire with activeCellIndex===null (idx falls back
  // to 0 for caption/alt but the image-edit section stays hidden), so
  // first-time users get a pointer instead of a silent gap.
  const hint = document.getElementById('rkr-cell-hint') as HTMLElement | null;

  /** Render one row per op (in click order), plus per-row delete
   * buttons, and update the undo/redo/save/reset button states. */
  function renderEditsPanel(id: string, s: LocalEditState): void {
    buttons.undo.disabled = s.ops.length === 0;
    buttons.redo.disabled = s.redoStack.length === 0;
    buttons.reset.hidden = s.ops.length === 0;
    if (buttons.save) buttons.save.disabled = !isDirty(s);
    const items = s.ops.map((op, idx) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'rkr-edits-step';
      span.textContent = `${idx + 1}. ${describeOp(op)}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'rkr-edits-del';
      del.textContent = '×';
      del.title = 'Delete this step';
      del.setAttribute('aria-label', `Delete step ${idx + 1}: ${describeOp(op)}`);
      del.addEventListener('click', () => {
        localDeleteAt(s, idx);
        refreshAfterEdit(id, s, `deleted step ${idx + 1}`);
      });
      li.replaceChildren(span, del);
      return li;
    });
    editsList.replaceChildren(...items);
  }

  /** Re-render the edits list + Save button state, persist to OPFS
   * (reload restores unsaved edits), and repaint the editor's <img>
   * via the canvas pipeline. The bake goes up only on Save. After
   * the pipeline resolves the dialog's in-modal preview is repointed
   * at the same blob URL so the author sees the result of each edit
   * without dismissing the dialog. */
  function refreshAfterEdit(id: string, s: LocalEditState, label: string): void {
    setStatus(`${label} ${id.slice(0, 8)}…`);
    renderEditsPanel(id, s);
    pipeline.persist(id, s);
    void repaint(id, s);
  }

  async function repaint(id: string, s: LocalEditState): Promise<void> {
    const url = await pipeline.preview(id, s.ops);
    onPreview(id, url);
    updateDialogPreview(url);
  }

  /** Sync the in-dialog <img> to the latest pipeline output for `id`.
   * The blob URL is owned by canvas-loaders' LRU, so we just point
   * src at it — no revoke responsibility here. Clears any pending CSS
   * tilt preview so the final canvas result is shown unrotated. */
  function updateDialogPreview(url: string): void {
    const img = document.getElementById('rkr-cell-preview') as HTMLImageElement | null;
    if (!img) return;
    img.style.transform = '';
    img.src = url;
    img.hidden = false;
  }

  /** Apply a CSS rotation to the dialog preview for instant tilt feedback
   * without re-running the canvas pipeline. Cleared by updateDialogPreview
   * when the canvas pipeline completes after commit. */
  function applyTiltPreview(deg: number): void {
    const img = document.getElementById('rkr-cell-preview') as HTMLImageElement | null;
    if (!img) return;
    img.style.transform = deg !== 0 ? `rotate(${deg}deg)` : '';
  }

  /** Mutate the active image's local state. Refuses if no image is
   * selected. Adding any op clears redoStack via localMutate. */
  function runEdit(label: string, mutator: (ops: SidecarOp[]) => SidecarOp[]): void {
    const id = activeImageId();
    if (!id) return;
    const s = pipeline.get(id);
    if (!s) return;
    localMutate(s, mutator);
    refreshAfterEdit(id, s, label);
  }

  /** Run `fn(id, state)` only when the active cell has a resolved id
   * AND its local state has been fetched. Collapses the id+state
   * guard shared by all the click handlers below. */
  function runWithState(fn: (id: string, s: LocalEditState) => void): void {
    const id = activeImageId();
    if (!id) return;
    const s = pipeline.get(id);
    if (!s) return;
    fn(id, s);
  }

  /** The package modals take a decoded source + pipeline (no data-layer
   * coupling); resolve them here from the blog's id-based loaders, then run
   * `open`. Surfaces load failures on the editor status line. */
  async function withCanvasSource(
    id: string,
    open: (source: CanvasSource, cache: PipelineCache) => Promise<void>
  ): Promise<void> {
    try {
      const { source, cache } = await pipeline.load(id);
      await open(source, cache);
    } catch (err) {
      setStatus(`edit: ${(err as Error).message}`, true);
    }
  }

  buttons.crop.addEventListener('click', () =>
    runWithState(
      (id, s) =>
        void withCanvasSource(id, (source, cache) =>
          openCropper(source, cache, s, () => refreshAfterEdit(id, s, 'crop'), setStatus)
        )
    )
  );
  buttons.rotateL.addEventListener('click', () =>
    runEdit('rotate', (ops) => appendRotate(ops, -90))
  );
  buttons.rotateR.addEventListener('click', () =>
    runEdit('rotate', (ops) => appendRotate(ops, 90))
  );
  buttons.flipH.addEventListener('click', () =>
    runEdit('flip', (ops) => appendFlip(ops, 'horizontal'))
  );
  buttons.flipV.addEventListener('click', () =>
    runEdit('flip', (ops) => appendFlip(ops, 'vertical'))
  );
  buttons.perspective.addEventListener('click', () =>
    runWithState(
      (id, s) =>
        void withCanvasSource(id, (source, cache) =>
          openPerspective(source, cache, s, () => refreshAfterEdit(id, s, 'perspective'), setStatus)
        )
    )
  );
  buttons.undo.addEventListener('click', () =>
    runWithState((id, s) => {
      localUndo(s);
      refreshAfterEdit(id, s, 'undo');
    })
  );
  buttons.redo.addEventListener('click', () =>
    runWithState((id, s) => {
      localRedo(s);
      refreshAfterEdit(id, s, 'redo');
    })
  );
  buttons.resample.addEventListener('click', () => {
    const w = Math.floor(Number(resampleInput.value) || 0);
    if (w <= 0) {
      // Empty input clears any existing resample op.
      runEdit('resample cleared', (ops) => ops.filter((o) => o.type !== 'resample'));
      return;
    }
    runEdit('resample', (ops) => [
      ...ops.filter((o) => o.type !== 'resample'),
      { type: 'resample', w, fit: 'inside' }
    ]);
  });
  tiltSlider.addEventListener('input', () => {
    const v = Math.max(-45, Math.min(45, Number(tiltSlider.value)));
    tiltInput.value = String(v);
    applyTiltPreview(v);
  });
  tiltInput.addEventListener('input', () => {
    const v = Math.max(-45, Math.min(45, Number(tiltInput.value) || 0));
    tiltSlider.value = String(v);
    applyTiltPreview(v);
  });
  buttons.tilt.addEventListener('click', () => {
    const deg = Math.max(-45, Math.min(45, Number(tiltInput.value) || 0));
    if (deg === 0) return;
    runEdit('rotate', (ops) => appendRotate(ops, deg));
  });
  buttons.reset.addEventListener('click', () =>
    runWithState((id, s) => {
      localMutate(s, () => []);
      resampleInput.value = '';
      refreshAfterEdit(id, s, 'edits reset');
    })
  );
  /** Commit the active image's ops (bake + sidecar), then repaint from
   * the committed state. */
  async function save(): Promise<boolean> {
    const id = activeImageId();
    const s = id ? pipeline.get(id) : undefined;
    if (!id || !s || !isDirty(s)) return false;
    setStatus(`saving edits ${id.slice(0, 8)}…`);
    try {
      await pipeline.commit(id, s);
    } catch (err) {
      setStatus(`save edits failed: ${(err as Error).message}`);
      throw err;
    }
    renderEditsPanel(id, s);
    await repaint(id, s);
    setStatus(`saved edits ${id.slice(0, 8)}…`);
    return true;
  }

  function discard(): void {
    runWithState((id, s) => {
      if (!isDirty(s)) return;
      s.ops = [...s.baseline.ops];
      s.redoStack = [...s.baseline.redoStack];
      refreshAfterEdit(id, s, 'edits discarded');
    });
  }

  const legacySave = buttons.save;
  if (legacySave) {
    legacySave.addEventListener('click', () => {
      // Guard against double-clicks during the (potentially multi-MB)
      // bake upload; renderEditsPanel resets it from isDirty.
      legacySave.disabled = true;
      save().catch(() => {
        legacySave.disabled = false;
      });
    });
  }

  function deactivate(): void {
    buttons.reset.hidden = true;
    resampleInput.value = '';
    buttons.undo.disabled = true;
    buttons.redo.disabled = true;
    if (buttons.save) buttons.save.disabled = true;
    editsList.replaceChildren();
    // Drop the dialog preview's src — otherwise reopening the dialog
    // for a different image would flash the previous image first.
    const preview = document.getElementById('rkr-cell-preview') as HTMLImageElement | null;
    if (preview) {
      preview.hidden = true;
      preview.removeAttribute('src');
    }
    section.hidden = true;
    section.dataset.ready = 'false';
    if (hint) hint.hidden = false;
  }

  function activateForId(id: string, stillCurrent: () => boolean): void {
    if (hint) hint.hidden = true;
    buttons.reset.hidden = true;
    resampleInput.value = '';
    buttons.undo.disabled = true;
    buttons.redo.disabled = true;
    if (buttons.save) buttons.save.disabled = true;
    editsList.replaceChildren();
    section.hidden = false;
    // data-ready flips to "true" once the async ensureLocalState
    // fetch settles. e2e tests wait on this before clicking any
    // image-edit button — otherwise getLocalEditState (sync) returns
    // null and the click silently no-ops.
    section.dataset.ready = 'false';
    void pipeline.ensure(id).then(
      (s) => {
        // Selection may have moved on while the meta fetch was in
        // flight; only paint if we're still on this id.
        if (!stillCurrent()) return;
        const resample = s.ops.find((o) => o.type === 'resample');
        if (resample && typeof resample.w === 'number') {
          resampleInput.value = String(resample.w);
        }
        renderEditsPanel(id, s);
        // Repaint from local ops: there might be unsaved edits from a
        // prior selection of this image.
        void repaint(id, s);
        section.dataset.ready = 'true';
      },
      () => {
        /* best-effort */
      }
    );
  }

  return { activateForId, deactivate, save, discard };
}
